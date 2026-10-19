/**
 * The browser side of the RPC channel (contract.md §4).
 *
 * One `WebSocket` per page, opened on boot. Calls are JSON frames with a
 * numeric id; the transport keeps a pending map. Services are *proxied* from
 * the server's `describe()` output, so `mountCtx.fs.list()` looks exactly like
 * the server-side service (contract.md §4, "automatic proxy").
 *
 * Failures are loud: a call made before the socket is open, or after it closed,
 * rejects with `EDISCONNECTED`; the kernel never silently falls back.
 */
import { codedError, isErrorCode, rpcError } from '../shared/errors.ts'
import {
  decodeValue,
  encodeValue,
  type DescribedService,
  type MethodDescriptor,
  type RpcResponse,
} from '../shared/rpc.ts'

/** The escape hatch: call any proxyable method by name (contract.md §4). */
export interface RpcClient {
  /** Call `<service>.<method>` with positional arguments. */
  call(method: string, ...args: unknown[]): Promise<unknown>
  /** End a subscription endpoint's session (contract.md §4); idempotent. */
  cancel(session: string): void
  /** Build an auto-proxy that mirrors the named server service's methods. */
  service<T extends object>(name: string, methods: readonly string[]): T
  /** Subscribe to broadcast server → client events; returns the unsubscriber. */
  on(topic: string, listener: (payload: unknown) => void): () => void
  /**
   * Subscribe to one subscription endpoint's events (contract.md §4): frames
   * carry the `session` the endpoint call returned.
   */
  onSession(session: string, listener: (payload: unknown) => void): () => void
  /** Resolves once the socket is open (or rejects with `EDISCONNECTED`). */
  ready(): Promise<void>
}

/** The endpoint path (contract.md §4). */
export const RPC_PATH = '/__diorama__/rpc'

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
}

export interface RpcClientOptions {
  /** Absolute endpoint URL, e.g. `ws://127.0.0.1:1234/__diorama__/rpc`. */
  url: string
  /** Console sink. Defaults to `console.error`. */
  log?: (message: string) => void
}

/** Create the channel for one page and start connecting immediately. */
export function createRpcClient(options: RpcClientOptions): RpcClient {
  const log = options.log ?? ((message: string) => console.error(message))
  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let nextId = 1
  let socket: WebSocket | undefined
  let open: Promise<void>

  const failAll = (error: unknown): void => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  const connect = (): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      try {
        socket = new WebSocket(options.url)
      } catch (error) {
        reject(codedError('EDISCONNECTED', `cannot open ${options.url}`, error))
        return
      }
      socket.onopen = () => {
        settled = true
        resolve()
      }
      socket.onerror = () => {
        if (!settled) {
          settled = true
          reject(codedError('EDISCONNECTED', `cannot connect to ${options.url}`))
        }
      }
      socket.onclose = () => {
        failAll(codedError('EDISCONNECTED', 'the RPC connection closed'))
        if (!settled) {
          settled = true
          reject(codedError('EDISCONNECTED', `cannot connect to ${options.url}`))
        }
      }
      socket.onmessage = event => {
        let message: RpcResponse
        try {
          message = JSON.parse(String(event.data)) as RpcResponse
        } catch {
          log(`[diorama] rpc: malformed frame from the server`)
          return
        }
        handle(message)
      }
    })
  }

  const subscribe = (topic: string, listener: (payload: unknown) => void): (() => void) => {
    const set = listeners.get(topic) ?? new Set()
    set.add(listener)
    listeners.set(topic, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(topic)
    }
  }

  const handle = (message: RpcResponse): void => {
    if (message.type === 'event') {
      // Session-scoped frames go to the session's listeners; broadcast frames
      // (no `session`) keep the M1 topic semantics.
      const topic = message.session ?? message.topic
      for (const listener of listeners.get(topic) ?? []) listener(decodeValue(message.payload))
      return
    }
    const request = pending.get(message.id)
    if (request === undefined) return
    pending.delete(message.id)
    if (message.type === 'result') request.resolve(decodeValue(message.value))
    else if (isErrorCode(message.code)) request.reject(codedError(message.code, message.message))
    else request.reject(codedError('EIO', message.message))
  }

  open = connect()
  open.catch(() => {})

  const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
    await open
    const current = socket
    if (current === undefined || current.readyState !== WebSocket.OPEN) {
      throw rpcError('EDISCONNECTED')
    }
    const id = nextId++
    const frame = JSON.stringify({ type: 'call', id, method, args: encodeValue(args) })
    return await new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      current.send(frame)
    })
  }

  /** Fire-and-forget control frame (session cancellation). */
  const cancel = (session: string): void => {
    const current = socket
    if (current === undefined || current.readyState !== WebSocket.OPEN) return
    current.send(JSON.stringify({ type: 'cancel', session }))
  }

  return {
    call,
    cancel,
    service<T extends object>(name: string, methods: readonly string[]): T {
      const proxy: Record<string, (...params: unknown[]) => Promise<unknown>> = {}
      for (const method of methods) proxy[method] = (...params) => call(`${name}.${method}`, ...params)
      return proxy as unknown as T
    },
    on(topic, listener) {
      const set = listeners.get(topic) ?? new Set()
      set.add(listener)
      listeners.set(topic, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(topic)
      }
    },
    onSession: (session, listener) => subscribe(session, listener),
    ready: () => open,
  }
}

/** `/__diorama__/rpc` as a WebSocket URL for a page origin. */
export function rpcUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}${RPC_PATH}`
}

export type { DescribedService, MethodDescriptor }
