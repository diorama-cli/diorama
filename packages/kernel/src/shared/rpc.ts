/**
 * The RPC wire protocol (contract.md §4). Shared by the server dispatcher and
 * the browser transport so the two cannot drift.
 *
 * Values travel as JSON. The one non-JSON value the kernel sends is
 * `Uint8Array` (`readBytes`): it is encoded per value as `{ $bytes: base64 }`
 * and restored on the other side. That is the only binary representation in v1.
 */

/** Client → server. */
export type RpcRequest =
  | { type: 'call'; id: number; method: string; args: unknown[] }
  | { type: 'cancel'; session: string }

/** Server → client. */
export type RpcResponse =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; code: string; message: string }
  | { type: 'event'; topic: string; payload: unknown; session?: string }

/** What a proxying service reports so the channel can whitelist its methods. */
export interface MethodDescriptor {
  /** Method name (the last segment of the RPC method). */
  name: string
  /** How many positional arguments it takes (informational, for proxies). */
  arity: number
}

/** Every server service that may be proxied implements this (contract.md §4). */
export interface DescribedService {
  describe(): MethodDescriptor[]
}

/**
 * Subscription endpoints (contract.md §4): a call to one of these registers a
 * push instead of returning a value. They are routed by convention name and do
 * not appear in `describe()` (which lists plain methods only).
 */
export const SUBSCRIPTION_METHOD = 'watch'

/** What a subscription endpoint returns: the session that tags its events. */
export interface SubscriptionStarted {
  session: string
}

/** The marker key of an encoded `Uint8Array`. */
export const BYTES_KEY = '$bytes'

const BASE64_CHUNK = 0x8000

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Encode values for JSON: `Uint8Array` becomes `{ $bytes }`; arrays recurse. */
export function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES_KEY]: toBase64(value) }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) out[key] = encodeValue(inner)
    return out
  }
  return value
}

/** Inverse of {@link encodeValue}. */
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record[BYTES_KEY] === 'string' && Object.keys(record).length === 1) {
      return fromBase64(record[BYTES_KEY] as string)
    }
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(record)) out[key] = decodeValue(inner)
    return out
  }
  return value
}

/** Split an RPC method (`<service>.<method>`) into its two parts. */
export function parseMethod(method: string): { service: string; name: string } | undefined {
  const dot = method.indexOf('.')
  if (dot <= 0 || dot === method.length - 1) return undefined
  return { service: method.slice(0, dot), name: method.slice(dot + 1) }
}
