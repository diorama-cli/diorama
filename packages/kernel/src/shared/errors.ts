/**
 * Error codes of the fs service, shared by the server half (which raises them)
 * and the client half (which surfaces them to plugins and components).
 */
export type FsErrorCode =
  | 'EINVAL'
  | 'EIO'
  | 'ENOENT'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EOUTSIDE'
  | 'EBINARY'

/** Code → HTTP status for the M0 `/api/fs/*` transport. */
export const FS_HTTP_STATUS: Record<FsErrorCode, number> = {
  EINVAL: 400,
  EIO: 500,
  ENOENT: 404,
  ENOTDIR: 400,
  EISDIR: 400,
  EOUTSIDE: 403,
  EBINARY: 415,
}

const MESSAGES: Record<FsErrorCode, string> = {
  EINVAL: 'invalid path',
  EIO: 'cannot read the mounted directory',
  ENOENT: 'no such file or directory',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  EOUTSIDE: 'path escapes the mount root',
  EBINARY: 'binary file',
}

/** Create an error with one of the kernel's fs codes. */
export function fsError(code: FsErrorCode, message = MESSAGES[code], cause?: unknown): Error & {
  code: FsErrorCode
} {
  const error = new Error(`${code}: ${message}`) as Error & { code: FsErrorCode; cause?: unknown }
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}
