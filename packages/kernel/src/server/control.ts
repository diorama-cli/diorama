/**
 * Control-plane transport (contract.md §7.1): a Unix domain socket carrying
 * NDJSON frames, with a server side (inside the gateway) and a client side
 * (inside the short-lived CLI).
 *
 * Both sides are line-buffered: a peer that sends half a frame is tolerated,
 * a line above `MAX_CONTROL_LINE_BYTES` ends the connection with `ETOOLARGE`.
 * The server is transport only; the method table belongs to the gateway.
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import {
  controlError,
  frameLine,
  isControlErrorCode,
  MAX_CONTROL_LINE_BYTES,
  parseRequest,
  requestIdOf,
  type ControlErrorCode,
  type ControlRequest,
  type ControlResponse,
  type ControlTopic,
} from '../shared/control.ts'

/**
 * Split incoming text into complete lines, keeping the unfinished remainder.
 * The limit is checked **after** a piece is accumulated: a large frame arrives
 * in several `data` events, and the overlong state latches until the
 * connection is dropped (its remaining bytes are no longer valid frames).
 */
class LineBuffer {
  /** Pieces of the unfinished line (a large frame arrives in many chunks). */
  private parts: string[] = []
  /** Characters held in `parts` (avoids joining on every chunk: 1 MiB frames). */
  private size = 0
  private overLimit = false

  /** Feed a chunk; returns the complete lines and whether the line limit was hit. */
  push(chunk: string): { lines: string[]; tooLarge: boolean } {
    if (this.overLimit) return { lines: [], tooLarge: true }
    if (chunk === '') return { lines: [], tooLarge: false }
    const newline = chunk.lastIndexOf('\n')
    const lines: string[] = []
    let tail = chunk
    if (newline !== -1) {
      const pieces = chunk.slice(0, newline).split('\n')
      tail = chunk.slice(newline + 1)
      const head = this.parts.length === 0 ? pieces[0]! : this.parts.join('') + pieces[0]
      this.parts = []
      this.size = 0
      // The completed line counts toward the limit like the remainder does: a
      // frame may only end after an over-limit prefix.
      if (head.length > MAX_CONTROL_LINE_BYTES) {
        this.overLimit = true
        return { lines: [], tooLarge: true }
      }
      const first = head.endsWith('\r') ? head.slice(0, -1) : head
      if (first !== '') lines.push(first)
      for (let index = 1; index < pieces.length; index++) {
        const piece = pieces[index]!
        const line = piece.endsWith('\r') ? piece.slice(0, -1) : piece
        if (line !== '') lines.push(line)
      }
    }
    if (tail === '') return { lines, tooLarge: false }
    this.parts.push(tail)
    this.size += tail.length
    if (this.size > MAX_CONTROL_LINE_BYTES) {
      this.overLimit = true
      this.parts = []
      this.size = 0
      return { lines: [], tooLarge: true }
    }
    return { lines, tooLarge: false }
  }
}

/** Exposed for the unit tests (the transport's line assembly). */
export { LineBuffer as __testLineBuffer }

/** One connection as the gateway sees it. */
export interface ControlPeer {
  /** Send a frame to this connection. */
  send(frame: ControlResponse): void
  /** Subscribe to events (`events` handler calls this). */
  subscribe(topics: readonly ControlTopic[]): void
  /** Event topics this connection subscribed to (for diagnostics/tests). */
  readonly topics: readonly ControlTopic[] | undefined
  /** Drop the connection. */
  close(): void
}

export interface ControlServerOptions {
  /** How a request frame is answered. A thrown error with a `code` becomes an error frame. */
  handle(method: string, params: Record<string, unknown>, peer: ControlPeer): Promise<object>
  /** Console sink for protocol problems (malformed frames, overlong lines). */
  log?: (message: string) => void
}

export interface ControlServer {
  readonly server: Server
  /** Console sink (same as the option); the gateway writes its log through it. */
  readonly log: (message: string) => void
  /** Listen on a Unix socket path; `EADDRINUSE` means someone else owns the path. */
  listen(path: string): Promise<void>
  /** Push one event to every connection subscribed to its topic. */
  emit(topic: ControlTopic, payload: object): void
  /** Live connections (diagnostics). */
  readonly connections: number
  /** Drop every connection and close the listener (idempotent). */
  close(): Promise<void>
}

/** Map whatever a handler threw to a control error code + message. */
function describeFailure(failure: unknown): { code: ControlErrorCode; message: string } {
  const code = (failure as { code?: unknown } | null)?.code
  const message = failure instanceof Error ? failure.message : String(failure)
  if (isControlErrorCode(code)) {
    const detail = message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message
    return { code, message: detail }
  }
  return { code: 'EBADREQUEST', message }
}

/** One live connection on the server side. */
interface LivePeer extends ControlPeer {
  socket: Socket
  subscribed: readonly ControlTopic[] | undefined
}

export function createControlServer(options: ControlServerOptions): ControlServer {
  const log = options.log ?? ((message: string) => console.error(message))
  const peers = new Set<LivePeer>()
  let closed = false

  const server = createServer(socket => {
    socket.setEncoding('utf8')
    const peer: LivePeer = {
      socket,
      subscribed: undefined,
      send(frame) {
        if (socket.writable) socket.write(`${frameLine(frame)}\n`)
      },
      subscribe(topics) {
        peer.subscribed = [...topics]
      },
      get topics() {
        return peer.subscribed
      },
      close() {
        socket.destroy()
      },
    }
    peers.add(peer)
    const buffer = new LineBuffer()

    const answer = async (line: string): Promise<void> => {
      let request: ControlRequest
      try {
        request = parseRequest(line)
      } catch (failure) {
        const { code, message } = describeFailure(failure)
        peer.send({ type: 'error', id: requestIdOf(line) ?? 0, code, message })
        return
      }
      try {
        const result = await options.handle(request.method, request.params as Record<string, unknown>, peer)
        peer.send({ type: 'result', id: request.id, result })
      } catch (failure) {
        const { code, message } = describeFailure(failure)
        peer.send({ type: 'error', id: request.id, code, message })
      }
    }

    socket.on('data', (chunk: string) => {
        const { lines, tooLarge } = buffer.push(chunk)
      if (tooLarge) {
        log(`[diorama] gateway: control frame above ${MAX_CONTROL_LINE_BYTES} bytes — closing the connection`)
        socket.destroy()
        return
      }
      for (const line of lines) void answer(line)
    })
    socket.on('error', (failure: Error) => {
      log(`[diorama] gateway: control connection error — ${failure.message}`)
    })
    socket.on('close', () => peers.delete(peer))
  })

  return {
    server,
    log,
    listen(path) {
      return new Promise<void>((resolve, reject) => {
        const onError = (failure: Error) => {
          server.off('listening', onListening)
          reject(failure)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(path)
      })
    },
    emit(topic, payload) {
      for (const peer of peers) {
        if (peer.subscribed === undefined || !peer.subscribed.includes(topic)) continue
        peer.send({ type: 'event', topic, payload })
      }
    },
    get connections() {
      return peers.size
    },
    async close() {
      if (closed) return
      closed = true
      for (const peer of peers) peer.socket.destroy()
      peers.clear()
      await new Promise<void>(done => server.close(() => done()))
    },
  }
}

/** The control client the CLI uses: one connection, requests paired by `id`. */
export interface ControlClient {
  request(method: string, params?: object): Promise<object>
  /** Listen for this connection's events; returns an unsubscribe (delivery only). */
  onEvent(listener: (topic: ControlTopic, payload: object) => void): () => void
  /** Close the connection (idempotent); pending requests reject with `EGATEWAYDEAD`. */
  close(): void
  readonly closed: boolean
}

export interface ControlClientOptions {
  /** Socket path (or Windows pipe name). */
  path: string
  /** Console sink; defaults to `console.error`. */
  log?: (message: string) => void
}

/**
 * Connect to the gateway. A refused connection is `EGATEWAYDEAD`, which the
 * CLI turns into "start the gateway" rather than a stack trace.
 */
export async function connectControl(options: ControlClientOptions): Promise<ControlClient> {
  const log = options.log ?? ((message: string) => console.error(message))
  const socket = createConnection(options.path)
  socket.setEncoding('utf8')
  const pending = new Map<number, { resolve: (value: object) => void; reject: (error: unknown) => void }>()
  const listeners = new Set<(topic: ControlTopic, payload: object) => void>()
  let nextId = 1
  let closed = false

  await new Promise<void>((resolve, reject) => {
    const onError = (failure: Error) => {
      socket.off('connect', onConnect)
      socket.destroy()
      const code = (failure as { code?: string }).code
      reject(
        code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK'
          ? controlError('EGATEWAYDEAD')
          : failure,
      )
    }
    const onConnect = () => {
      socket.off('error', onError)
      resolve()
    }
    socket.once('error', onError)
    socket.once('connect', onConnect)
  })

  const failAll = (error: unknown): void => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  const buffer = new LineBuffer()
  socket.on('data', (chunk: string) => {
    const { lines, tooLarge } = buffer.push(chunk)
    if (tooLarge) {
      log('[diorama] control: a frame from the gateway is too large; closing')
      socket.destroy()
      return
    }
    for (const line of lines) {
      let frame: ControlResponse
      try {
        frame = JSON.parse(line) as ControlResponse
      } catch {
        log(`[diorama] control: malformed frame from the gateway: ${line.slice(0, 120)}`)
        continue
      }
      if (frame.type === 'event') {
        for (const listener of [...listeners]) listener(frame.topic, frame.payload)
        continue
      }
      const entry = pending.get(frame.id)
      pending.delete(frame.id)
      if (entry === undefined) continue
      if (frame.type === 'error') entry.reject(controlError(frame.code, frame.message))
      else entry.resolve(frame.result)
    }
  })
  socket.on('error', (failure: Error) => log(`[diorama] control: connection error — ${failure.message}`))
  socket.on('close', () => {
    closed = true
    failAll(controlError('EGATEWAYDEAD', 'the gateway closed the connection'))
  })

  return {
    request(method, params = {}) {
      if (closed) return Promise.reject(controlError('EGATEWAYDEAD', 'the connection is closed'))
      const id = nextId++
      const frame: ControlRequest = { type: 'request', id, method, params }
      return new Promise<object>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.write(`${frameLine(frame)}\n`)
      })
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close() {
      if (closed) return
      closed = true
      failAll(controlError('EGATEWAYDEAD', 'the connection is closed'))
      socket.destroy()
    },
    get closed() {
      return closed
    },
  }
}
