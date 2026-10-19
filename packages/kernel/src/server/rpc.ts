/**
 * The RPC channel (contract.md §4): a WebSocket on the mount's origin, carrying
 * JSON frames. Server services on the mount context are proxied automatically —
 * a `call` names `<service>.<method>` and the dispatcher only forwards names the
 * service itself lists in `describe()`, so a plugin's undocumented methods are
 * not reachable from a page.
 *
 * Byte values are encoded per value (`{ $bytes }`, see `shared/rpc.ts`); there
 * is no chunking in v1 — `ctx.fs` refuses oversized files with `ETOOLARGE`.
 */
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { isErrorCode, rpcError } from '../shared/errors.ts'
import {
  decodeValue,
  encodeValue,
  parseMethod,
  SUBSCRIPTION_METHOD,
  type DescribedService,
  type RpcRequest,
  type RpcResponse,
} from '../shared/rpc.ts'

/** Routes method calls to services living on the mount context. */
export interface RpcDispatcher {
  call(method: string, args: unknown[]): Promise<unknown>
  /** Services currently proxyable, by name (diagnostics). */
  services(): string[]
  /**
   * Start a subscription endpoint (contract.md §4): `service.watch(path, push)`
   * returns the disposer that ends it. Absent = no subscriptions on this mount.
   */
  subscribe?(method: string, args: unknown[], push: (payload: unknown) => void): Promise<() => void>
}

/** A live subscription of one connection. */
interface Subscription {
  dispose: () => void
}

/** Who a subscription belongs to: one WebSocket = one peer. */
interface Peer {
  socket: WebSocket
  subscriptions: Map<string, Subscription>
}

function isDescribed(service: unknown): service is DescribedService {
  return (
    service !== null &&
    typeof service === 'object' &&
    typeof (service as { describe?: unknown }).describe === 'function'
  )
}

/**
 * Build the dispatcher over `services()`: named service objects. Only methods
 * listed by `describe()` are reachable (`EMETHOD` otherwise), and an argument
 * list longer than the declared arity is `EBADREQUEST` rather than a silent
 * extra argument.
 */
export function createDispatcher(services: () => Record<string, unknown>): RpcDispatcher {
  return {
    services: () => Object.keys(services()),
    async call(method, args) {
      const parsed = parseMethod(method)
      if (parsed === undefined) throw rpcError('EBADREQUEST', `method "${method}" is not <service>.<method>`)
      const service = services()[parsed.service]
      if (service === undefined) throw rpcError('ESERVICE', `no service "${parsed.service}" on this mount`)
      if (!isDescribed(service)) {
        throw rpcError('ESERVICE', `service "${parsed.service}" is not proxyable (it does not describe() its methods)`)
      }
      const descriptor = service.describe().find(entry => entry.name === parsed.name)
      if (descriptor === undefined) {
        throw rpcError('EMETHOD', `service "${parsed.service}" has no proxyable method "${parsed.name}"`)
      }
      if (args.length > descriptor.arity) {
        throw rpcError('EBADREQUEST', `${parsed.service}.${parsed.name} takes at most ${descriptor.arity} argument(s), got ${args.length}`)
      }
      const target = (service as unknown as Record<string, unknown>)[parsed.name]
      if (typeof target !== 'function') {
        throw rpcError('EMETHOD', `${parsed.service}.${parsed.name} is not callable`)
      }
      return await (target as (...params: unknown[]) => unknown).apply(service, args)
    },
  }
}

/** Error body for a failed call, mapped from whatever the service threw. */
function failure(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (isErrorCode(code)) {
    const detail = message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message
    return { code, message: detail }
  }
  return { code: 'EIO', message }
}

/**
 * Handle one request frame. Never throws: a malformed or failed call becomes an
 * `error` frame carrying its code, so one bad call cannot take the socket down.
 *
 * `peer` is where subscription endpoints live; without it a subscription call
 * is refused (`EMETHOD`), which is what a server-side test wants.
 */
export async function handleFrame(
  dispatcher: RpcDispatcher,
  raw: string,
  send: (message: RpcResponse) => void,
  log: (message: string) => void,
  peer?: Peer,
): Promise<void> {
  let request: RpcRequest
  try {
    request = JSON.parse(raw) as RpcRequest
  } catch {
    log('[diorama] rpc: malformed frame (not JSON)')
    return
  }
  if (request === null || typeof request !== 'object') {
    log(`[diorama] rpc: unsupported frame ${JSON.stringify(request).slice(0, 120)}`)
    return
  }
  if (request.type === 'cancel') {
    const session = (request as { session?: unknown }).session
    if (typeof session !== 'string') {
      log('[diorama] rpc: cancel without a session')
      return
    }
    const live = peer?.subscriptions.get(session)
    if (live === undefined) {
      log(`[diorama] rpc: cancel for unknown session ${session}`)
      return
    }
    peer?.subscriptions.delete(session)
    live.dispose()
    return
  }
  if (request.type !== 'call') {
    log(`[diorama] rpc: unsupported frame ${JSON.stringify(request).slice(0, 120)}`)
    return
  }
  const { id, method } = request
  if (typeof id !== 'number' || typeof method !== 'string' || !Array.isArray(request.args)) {
    send({ type: 'error', id: typeof id === 'number' ? id : 0, code: 'EBADREQUEST', message: 'malformed call frame' })
    return
  }
  const args = (decodeValue(request.args) as unknown[]) ?? []
  const serviceName = parseMethod(method)?.service
  const name = parseMethod(method)?.name
  if (serviceName !== undefined && name === SUBSCRIPTION_METHOD && dispatcher.subscribe !== undefined) {
    if (peer === undefined) {
      send({ type: 'error', id, code: 'EMETHOD', message: `"${serviceName}.${name}" is a subscription; it needs a connection` })
      return
    }
    const session = `${serviceName}:${++nextSession}`
    let dispose: () => void
    try {
      dispose = await dispatcher.subscribe(method, args, payload => {
        send({ type: 'event', topic: session, payload: encodeValue(payload), session })
      })
    } catch (error) {
      const { code, message } = failure(error)
      send({ type: 'error', id, code, message })
      return
    }
    peer.subscriptions.set(session, { dispose })
    send({ type: 'result', id, value: { session } })
    return
  }
  try {
    const value = await dispatcher.call(method, args)
    send({ type: 'result', id, value: encodeValue(value) })
  } catch (error) {
    const { code, message } = failure(error)
    if (code === 'EIO' || code === 'ESERVICE' || code === 'EMETHOD') log(`[diorama] rpc: ${method} failed — ${message}`)
    send({ type: 'error', id, code, message })
  }
}

/** Session ids are unique across a channel's lifetime (diagnostics only). */
let nextSession = 0

export interface RpcChannelOptions {
  dispatcher: RpcDispatcher
  /** Console sink for protocol-level problems. */
  log?: (message: string) => void
}

/** The channel: attach to the mount's HTTP server, push events to every page. */
export class RpcChannel {
  private readonly peers = new Map<WebSocket, Peer>()
  private readonly server: WebSocketServer
  private readonly log: (message: string) => void

  constructor(options: RpcChannelOptions) {
    this.log = options.log ?? (message => console.error(message))
    this.server = new WebSocketServer({ noServer: true })
    this.server.on('connection', socket => {
      const peer: Peer = { socket, subscriptions: new Map() }
      this.peers.set(socket, peer)
      socket.on('message', (data: Buffer | string) => {
        void handleFrame(options.dispatcher, data.toString(), message => this.sendTo(socket, message), this.log, peer)
      })
      socket.on('close', () => this.drop(socket))
      socket.on('error', () => this.drop(socket))
    })
  }

  /** Forget a peer and end its subscriptions (contract.md §4: close = cancel). */
  private drop(socket: WebSocket): void {
    const peer = this.peers.get(socket)
    this.peers.delete(socket)
    if (peer === undefined) return
    for (const subscription of peer.subscriptions.values()) subscription.dispose()
    peer.subscriptions.clear()
  }

  /** Whether a page is connected right now (diagnostics). */
  get connected(): number {
    return this.peers.size
  }

  /** Live subscriptions across all connections (diagnostics/tests). */
  get subscriptions(): number {
    let total = 0
    for (const peer of this.peers.values()) total += peer.subscriptions.size
    return total
  }

  /** Accept an HTTP upgrade for the RPC endpoint; returns false for other paths. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (request.url ?? '').split('?')[0]
    if (path !== RPC_PATH) return false
    this.server.handleUpgrade(request, socket, head, ws => {
      this.server.emit('connection', ws, request)
    })
    return true
  }

  /** Push one event to every connected page (M2's watch drives this). */
  broadcast(topic: string, payload: unknown): void {
    const message: RpcResponse = { type: 'event', topic, payload: encodeValue(payload) }
    for (const socket of this.peers.keys()) this.sendTo(socket, message)
  }

  close(): void {
    // End subscriptions, then cut the sockets: `close()` alone is a handshake,
    // and the HTTP server's `close()` waits for every socket to go away.
    for (const socket of [...this.peers.keys()]) {
      this.drop(socket)
      socket.terminate()
    }
    this.peers.clear()
    this.server.close()
  }

  private sendTo(socket: WebSocket, message: RpcResponse): void {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(message))
  }
}

/** The endpoint path (same origin and port as the mount). */
export const RPC_PATH = '/__diorama__/rpc'
