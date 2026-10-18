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
  type DescribedService,
  type RpcRequest,
  type RpcResponse,
} from '../shared/rpc.ts'

/** Routes method calls to services living on the mount context. */
export interface RpcDispatcher {
  call(method: string, args: unknown[]): Promise<unknown>
  /** Services currently proxyable, by name (diagnostics). */
  services(): string[]
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
 */
export async function handleFrame(
  dispatcher: RpcDispatcher,
  raw: string,
  send: (message: RpcResponse) => void,
  log: (message: string) => void,
): Promise<void> {
  let request: RpcRequest
  try {
    request = JSON.parse(raw) as RpcRequest
  } catch {
    log('[diorama] rpc: malformed frame (not JSON)')
    return
  }
  if (request === null || typeof request !== 'object' || request.type !== 'call') {
    log(`[diorama] rpc: unsupported frame ${JSON.stringify(request).slice(0, 120)}`)
    return
  }
  const { id, method } = request
  if (typeof id !== 'number' || typeof method !== 'string' || !Array.isArray(request.args)) {
    send({ type: 'error', id: typeof id === 'number' ? id : 0, code: 'EBADREQUEST', message: 'malformed call frame' })
    return
  }
  try {
    const value = await dispatcher.call(method, (decodeValue(request.args) as unknown[]) ?? [])
    send({ type: 'result', id, value: encodeValue(value) })
  } catch (error) {
    const { code, message } = failure(error)
    if (code === 'EIO' || code === 'ESERVICE' || code === 'EMETHOD') log(`[diorama] rpc: ${method} failed — ${message}`)
    send({ type: 'error', id, code, message })
  }
}

export interface RpcChannelOptions {
  dispatcher: RpcDispatcher
  /** Console sink for protocol-level problems. */
  log?: (message: string) => void
}

/** The channel: attach to the mount's HTTP server, push events to every page. */
export class RpcChannel {
  private readonly peers = new Set<WebSocket>()
  private readonly server: WebSocketServer
  private readonly log: (message: string) => void

  constructor(options: RpcChannelOptions) {
    this.log = options.log ?? (message => console.error(message))
    this.server = new WebSocketServer({ noServer: true })
    this.server.on('connection', socket => {
      this.peers.add(socket)
      socket.on('message', (data: Buffer | string) => {
        void handleFrame(options.dispatcher, data.toString(), message => this.sendTo(socket, message), this.log)
      })
      socket.on('close', () => this.peers.delete(socket))
      socket.on('error', () => this.peers.delete(socket))
    })
  }

  /** Whether a page is connected right now (diagnostics). */
  get connected(): number {
    return this.peers.size
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
    for (const socket of this.peers) this.sendTo(socket, message)
  }

  close(): void {
    for (const socket of this.peers) socket.close()
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
