/**
 * The browser side of the RPC channel (contract.md §4).
 *
 * One `WebSocket` per page, opened on boot. Calls are JSON frames with a
 * numeric id; the transport keeps a pending map. Services are *proxied* from
 * the server's `describe()` output, so `mountCtx.fs.list()` looks exactly like
 * the server-side service (contract.md §4, "automatic proxy").
 *
 * Failures are loud: a call made after the socket closed rejects with
 * `EDISCONNECTED`; the kernel never silently falls back. But a page that lost
 * its network is not dead — the channel keeps trying, and when it comes back it
 * restarts every subscription endpoint (`watchEndpoint`) and tells the page
 * through `onReconnect`, so live content resumes without a reload.
 */
import { codedError, isErrorCode, rpcError } from '../shared/errors.ts'
import {
  decodeValue,
  encodeValue,
  type DescribedService,
  type MethodDescriptor,
  type RpcResponse,
  type SubscriptionStarted,
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
  /**
   * Start a subscription endpoint and keep it started (contract.md §4): the
   * call is replayed after a reconnect, so the listener outlives the socket.
   */
  watchEndpoint(method: string, args: readonly unknown[], listener: (payload: unknown) => void): () => void
  /**
   * Called when the channel came back after a drop (never on the first
   * connect). Watches resume on their own; this is for state that the page
   * derived while the socket was down — a file changed on disk during the
   * outage produces no event, so the readers re-read.
   */
  onReconnect(listener: () => void): () => void
  /** Resolves once the socket is open (or rejects with `EDISCONNECTED`). */
  ready(): Promise<void>
  /** Close the socket and stop reconnecting (a page unloading). */
  close(): void
}

/** The endpoint path (contract.md §4). */
export const RPC_PATH = '/__diorama__/rpc'

/** How often an idle page proves its connection is alive (contract.md §4). */
export const HEARTBEAT_MS = 5_000

/** Frames older than this mean the socket is a zombie: drop it and reconnect. */
export const HEARTBEAT_TIMEOUT_MS = 20_000

/** First reconnect delay; doubles up to {@link RETRY_MAX_MS}. */
export const RETRY_INITIAL_MS = 500

/** Longest wait between reconnect attempts. */
export const RETRY_MAX_MS = 10_000

interface Pending {
  resolve(value: unknown): void
  reject(error: unknown): void
}

/** One subscription endpoint the channel keeps alive across reconnects. */
interface Endpoint {
  method: string
  args: readonly unknown[]
  listener: (payload: unknown) => void
  /** The server-side session of the current connection, once started. */
  session?: string
}

export interface RpcClientOptions {
  /** Absolute endpoint URL, e.g. `ws://127.0.0.1:1234/__diorama__/rpc`. */
  url: string
  /** Console sink. Defaults to `console.error`. */
  log?: (message: string) => void
  /** Socket factory; defaults to the platform `WebSocket` (tests inject one). */
  connect?: (url: string) => WebSocket
  /** Liveness timing (tests shorten it; the page keeps the contract's values). */
  heartbeat?: { everyMs?: number; timeoutMs?: number }
  /** Reconnect backoff (tests shorten it). */
  retry?: { initialMs?: number; maxMs?: number }
}

/** Create the channel for one page and start connecting immediately. */
export function createRpcClient(options: RpcClientOptions): RpcClient {
  const log = options.log ?? ((message: string) => console.error(message))
  const factory = options.connect ?? ((url: string) => new WebSocket(url))
  const everyMs = options.heartbeat?.everyMs ?? HEARTBEAT_MS
  const timeoutMs = options.heartbeat?.timeoutMs ?? HEARTBEAT_TIMEOUT_MS
  const initialMs = options.retry?.initialMs ?? RETRY_INITIAL_MS
  const maxMs = options.retry?.maxMs ?? RETRY_MAX_MS
  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const reconnectListeners = new Set<() => void>()
  const endpoints = new Set<Endpoint>()
  let nextId = 1
  let socket: WebSocket | undefined
  let open: Promise<void> = Promise.resolve()
  /** Set once the page closed the channel: no more attempts. */
  let closed = false
  /** Whether a connection ever opened (distinguishes "booting" from "dropped"). */
  let opened = false
  /** Attempts so far: the first one that succeeds is not a *re*connect. */
  let dials = 0
  let retryDelay = initialMs
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let lastFrameAt = 0

  const failAll = (error: unknown): void => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  const stopHeartbeat = (): void => {
    if (heartbeat === undefined) return
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  /**
   * A dropped network does not close the socket by itself: the browser only
   * finds out when a frame is due. Ping on a timer and treat a long silence as
   * a dead socket (contract.md §4), so the page reconnects in seconds instead
   * of waiting for the OS.
   */
  const startHeartbeat = (): void => {
    stopHeartbeat()
    lastFrameAt = Date.now()
    heartbeat = setInterval(() => {
      const current = socket
      if (current === undefined || current.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastFrameAt > timeoutMs) {
        log('[diorama] rpc: the connection stopped answering; reconnecting')
        abandon(current, 'the RPC connection timed out')
        return
      }
      try {
        current.send(JSON.stringify({ type: 'ping' }))
      } catch {
        abandon(current, 'the RPC connection stopped accepting frames')
      }
    }, everyMs)
  }

  const scheduleReconnect = (): void => {
    if (closed || retryTimer !== undefined) return
    const delay = retryDelay
    retryDelay = Math.min(retryDelay * 2, maxMs)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void dial()
    }, delay)
  }

  /** Give up on one socket (dead or closed) and queue the next attempt. */
  const abandon = (target: WebSocket, reason: string): void => {
    if (socket !== target) return
    socket = undefined
    stopHeartbeat()
    target.onopen = null
    target.onclose = null
    target.onerror = null
    target.onmessage = null
    try {
      target.close()
    } catch {
      // A socket that already died throws here; nothing left to do.
    }
    failAll(codedError('EDISCONNECTED', reason))
    scheduleReconnect()
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
    if (message.type === 'pong') return
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

  /** Open one socket and resolve when it is up (rejects when it is not). */
  const dial = (): Promise<void> => {
    if (closed) return Promise.reject(codedError('EDISCONNECTED', 'the RPC channel is closed'))
    dials++
    open = new Promise<void>((resolve, reject) => {
      let settled = false
      let next: WebSocket
      try {
        next = factory(options.url)
      } catch (error) {
        settled = true
        reject(codedError('EDISCONNECTED', `cannot open ${options.url}`, error))
        scheduleReconnect()
        return
      }
      socket = next
      next.onopen = () => {
        if (socket !== next) return
        settled = true
        // A first connection that took several attempts (the server was not up
        // yet) is a reconnect for the page: nothing it read during boot landed.
        const resumed = opened || dials > 1
        opened = true
        retryDelay = initialMs
        startHeartbeat()
        resolve()
        void resumeEndpoints()
        if (!resumed) return
        for (const listener of [...reconnectListeners]) listener()
      }
      next.onerror = () => {
        if (socket !== next || settled) return
        settled = true
        reject(codedError('EDISCONNECTED', `cannot connect to ${options.url}`))
      }
      next.onclose = () => {
        // A socket this channel already replaced says nothing about the page.
        if (socket !== next) {
          if (!settled) {
            settled = true
            reject(codedError('EDISCONNECTED', `cannot connect to ${options.url}`))
          }
          return
        }
        socket = undefined
        stopHeartbeat()
        failAll(codedError('EDISCONNECTED', 'the RPC connection closed'))
        if (!settled) {
          settled = true
          reject(codedError('EDISCONNECTED', `cannot connect to ${options.url}`))
        }
        scheduleReconnect()
      }
      next.onmessage = event => {
        lastFrameAt = Date.now()
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
    open.catch(() => {})
    return open
  }

  /** Start one endpoint on the current connection. */
  const startEndpoint = async (endpoint: Endpoint): Promise<void> => {
    try {
      const value = await call(endpoint.method, ...endpoint.args)
      const started = value as SubscriptionStarted
      if (!endpoints.has(endpoint)) {
        cancel(started.session)
        return
      }
      if (endpoint.session !== undefined) {
        const stale = listeners.get(endpoint.session)
        stale?.delete(endpoint.listener)
        if (stale !== undefined && stale.size === 0) listeners.delete(endpoint.session)
      }
      endpoint.session = started.session
      const set = listeners.get(started.session) ?? new Set()
      set.add(endpoint.listener)
      listeners.set(started.session, set)
    } catch (error) {
      // A dropped connection is the normal case here: the next connect replays
      // every endpoint. Anything else is worth a line on the console.
      if ((error as { code?: unknown } | null)?.code === 'EDISCONNECTED') return
      log(`[diorama] rpc: ${endpoint.method} could not start: ${(error as Error).message}`)
    }
  }

  /** After a reconnect: every endpoint starts again on the new connection. */
  const resumeEndpoints = async (): Promise<void> => {
    for (const endpoint of [...endpoints]) await startEndpoint(endpoint)
  }

  const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
    let current = socket
    if (current === undefined || current.readyState !== WebSocket.OPEN) {
      // Booting: wait for the attempt in flight. Dropped: fail loud, the page
      // shows the error and `onReconnect` brings it back (contract.md §4).
      if (opened) throw rpcError('EDISCONNECTED')
      await open
      current = socket
      if (current === undefined || current.readyState !== WebSocket.OPEN) throw rpcError('EDISCONNECTED')
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

  void dial()

  return {
    call,
    cancel,
    service<T extends object>(name: string, methods: readonly string[]): T {
      const proxy: Record<string, (...params: unknown[]) => Promise<unknown>> = {}
      for (const method of methods) proxy[method] = (...params) => call(`${name}.${method}`, ...params)
      return proxy as unknown as T
    },
    on(topic, listener) {
      return subscribe(topic, listener)
    },
    onSession: (session, listener) => subscribe(session, listener),
    watchEndpoint(method, args, listener) {
      const endpoint: Endpoint = { method, args, listener }
      endpoints.add(endpoint)
      const current = socket
      if (current !== undefined && current.readyState === WebSocket.OPEN) void startEndpoint(endpoint)
      return () => {
        if (!endpoints.delete(endpoint)) return
        const session = endpoint.session
        endpoint.session = undefined
        if (session === undefined) return
        const set = listeners.get(session)
        set?.delete(listener)
        if (set !== undefined && set.size === 0) listeners.delete(session)
        cancel(session)
      }
    },
    onReconnect(listener) {
      reconnectListeners.add(listener)
      return () => {
        reconnectListeners.delete(listener)
      }
    },
    ready: () => open,
    close() {
      closed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      stopHeartbeat()
      const current = socket
      socket = undefined
      if (current === undefined) return
      current.onopen = null
      current.onclose = null
      current.onerror = null
      current.onmessage = null
      try {
        current.close()
      } catch {
        // Already gone.
      }
      failAll(codedError('EDISCONNECTED', 'the RPC channel was closed'))
    },
  }
}

/** `/__diorama__/rpc` as a WebSocket URL for a page origin. */
export function rpcUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}${RPC_PATH}`
}

export type { DescribedService, MethodDescriptor }
