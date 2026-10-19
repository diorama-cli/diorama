/**
 * The gateway control plane (contract.md §7): the CLI and the gateway share
 * this module. It is *not* part of the plugin contract — plugins never see it —
 * but it ships with the same build as the kernel, so the two ends cannot drift.
 *
 * Wire form: NDJSON over a Unix domain socket. One JSON object per line, one
 * line at most `MAX_CONTROL_LINE_BYTES`; requests carry a numeric `id` that the
 * response echoes, and a connection may have several requests in flight.
 */
import { ControlError } from './errors.ts'

/** Frames the CLI sends to the gateway. */
export type ControlRequest = { type: 'request'; id: number; method: string; params: object }

/** Frames the gateway sends back. */
export type ControlResponse =
  | { type: 'result'; id: number; result: object }
  | { type: 'error'; id: number; code: ControlErrorCode; message: string }
  | { type: 'event'; topic: ControlTopic; payload: object }

/** Event topics (contract.md §7.3). A connection receives them after `events`. */
export type ControlTopic = 'mounted' | 'unmounted' | 'degraded' | 'recovered'

export const CONTROL_TOPICS: readonly ControlTopic[] = ['mounted', 'unmounted', 'degraded', 'recovered']

/** Error codes of the control plane (contract.md §7.3). */
export type ControlErrorCode =
  | 'EBADREQUEST'
  | 'EMETHOD'
  | 'ENOMOUNT'
  | 'EADDRINUSE'
  | 'ENOTDIR'
  | 'ETOOLARGE'
  | 'EGATEWAYDEAD'
  | 'ESTARTING'

const CONTROL_MESSAGES: Record<ControlErrorCode, string> = {
  EBADREQUEST: 'malformed control frame or params',
  EMETHOD: 'unknown control method',
  ENOMOUNT: 'no such mount',
  EADDRINUSE: 'port is already in use',
  ENOTDIR: 'not a readable directory',
  ETOOLARGE: 'control frame exceeds the line limit',
  EGATEWAYDEAD: 'the gateway is not running',
  ESTARTING: 'the gateway is starting up',
}

/** Whether a value is one of the control plane's error codes. */
export function isControlErrorCode(code: unknown): code is ControlErrorCode {
  return typeof code === 'string' && Object.hasOwn(CONTROL_MESSAGES, code)
}

/** Create an error carrying a control-plane code (the message keeps the code prefix). */
export function controlError<C extends ControlErrorCode>(code: C, message = CONTROL_MESSAGES[code]): ControlError {
  return new ControlError(code, message)
}

/** One mount as the control plane reports it (contract.md §7.3). */
export interface MountStatus {
  mountId: string
  /** Absolute directory (realpath) the mount serves. */
  root: string
  port: number
  /** Origin of the mount's page, e.g. `http://127.0.0.1:54321/`. */
  url: string
  state: 'starting' | 'ok' | 'degraded' | 'stopped'
  /** Milliseconds since epoch when the mount entered `state`. */
  since: number
  /** The `diorama.toml` the configuration came from; absent when defaults apply. */
  configFile?: string
  /** Client plugin selection, in boot order. */
  plugins: string[]
  /** Effective ignore patterns (what `fs.list` hides). */
  hidden: string[]
  /** Why the mount is degraded (contract.md §11.1). */
  lastError?: { code?: string; message: string; at: number }
}

/** What `ping` answers (contract.md §7.3). */
export interface GatewayInfo {
  pid: number
  version: string
  contract: string
  protocol: typeof CONTROL_PROTOCOL
  startedAt: number
}

/** What `status` answers (contract.md §7.3). */
export interface GatewayStatus extends GatewayInfo {
  state: 'ok' | 'degraded'
  mounts: MountStatus[]
}

/** What a client sends: an id plus either frame. */
export type AnyControlFrame = ControlRequest | ControlResponse

/** The largest line a control connection accepts (contract.md §7.1: 1 MiB). */
export const MAX_CONTROL_LINE_BYTES = 1024 * 1024

/** The protocol number advertised by `ping` (contract.md §7.3). */
export const CONTROL_PROTOCOL = 1

/**
 * Parse one line into a request. Throws `ControlError('EBADREQUEST')` for
 * anything that is not a well-formed request frame; the caller decides whether
 * it can still answer (it can when `id` was readable).
 */
export function parseRequest(line: string): ControlRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw controlError('EBADREQUEST', 'frame is not JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw controlError('EBADREQUEST', 'frame is not an object')
  }
  const frame = value as Record<string, unknown>
  if (frame.type !== 'request') throw controlError('EBADREQUEST', `unsupported frame type ${JSON.stringify(frame.type)}`)
  if (typeof frame.id !== 'number' || !Number.isInteger(frame.id)) throw controlError('EBADREQUEST', 'frame has no numeric id')
  if (typeof frame.method !== 'string' || frame.method === '') throw controlError('EBADREQUEST', 'frame has no method')
  const params = frame.params ?? {}
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw controlError('EBADREQUEST', 'params must be an object')
  }
  return { type: 'request', id: frame.id, method: frame.method, params: params as object }
}

/** Serialise one frame as a line (no trailing newline; the transport adds it). */
export function frameLine(frame: ControlResponse | ControlRequest): string {
  return JSON.stringify(frame)
}

/** Read the numeric id out of a frame that failed to parse (for a best-effort error answer). */
export function requestIdOf(line: string): number | undefined {
  try {
    const value = JSON.parse(line) as { id?: unknown }
    return typeof value?.id === 'number' && Number.isInteger(value.id) ? value.id : undefined
  } catch {
    return undefined
  }
}

/** Resolve the control-plane error code of a thrown value (`EADDRINUSE` from `net`, …). */
export function controlCodeOf(error: unknown): ControlErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return isControlErrorCode(code) ? code : undefined
}
