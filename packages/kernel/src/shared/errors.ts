/**
 * Error codes of the fs service, shared by the server half (which raises them)
 * and the client half (which surfaces them to plugins and components)
 * (contract.md §3.1), plus the codes the RPC channel itself raises (§4).
 */
export type FsErrorCode =
  | 'EINVAL'
  | 'EIO'
  | 'ENOENT'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EOUTSIDE'
  | 'EBINARY'
  | 'ETOOLARGE'

/** Codes the RPC channel itself raises (contract.md §4). */
export type RpcErrorCode = 'ESERVICE' | 'EMETHOD' | 'EBADREQUEST' | 'EDISCONNECTED'

export type ErrorCode = FsErrorCode | RpcErrorCode

const MESSAGES: Record<ErrorCode, string> = {
  EINVAL: 'invalid path',
  EIO: 'cannot read the mounted directory',
  ENOENT: 'no such file or directory',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  EOUTSIDE: 'path escapes the mount root',
  EBINARY: 'binary file',
  ETOOLARGE: 'file is larger than the kernel limit',
  ESERVICE: 'no such service (is the page connected?)',
  EMETHOD: 'no such method on the service',
  EBADREQUEST: 'malformed RPC request',
  EDISCONNECTED: 'the page is not connected to the server',
}

/** Whether a value is one of the kernel's error codes. */
export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(MESSAGES, code)
}

/** Create an error carrying one of the kernel's codes. */
export function codedError<C extends ErrorCode>(code: C, message = MESSAGES[code], cause?: unknown): Error & {
  code: C
} {
  const error = new Error(`${code}: ${message}`) as Error & { code: C; cause?: unknown }
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

/** Create an `ctx.fs` error (`EINVAL`, `EBINARY`, …). */
export function fsError(code: FsErrorCode, message = MESSAGES[code], cause?: unknown): Error & { code: FsErrorCode } {
  return codedError(code, message, cause)
}

/**
 * Error of the gateway control plane (contract.md §7): the CLI and the gateway
 * share its `code`, which is one of `ControlErrorCode` (see `shared/control.ts`).
 * Declared here without importing the control module so the fs/RPC error
 * helpers stay dependency-free.
 */
export class ControlError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ControlError'
    this.code = code
  }
}

/** Create an RPC error (`ESERVICE`, `EMETHOD`, …). */
export function rpcError(code: RpcErrorCode, message = MESSAGES[code]): Error & { code: RpcErrorCode } {
  return codedError(code, message)
}
