/**
 * Client half of `ctx.fs` (docs/m0/spec.md §4): the browser-side face of the
 * per-mount fs service. It speaks the M0 HTTP transport (`/api/fs/*`); M1
 * replaces the transport behind this same method surface.
 */
import { fsError, type FsErrorCode } from '../shared/errors.ts'
import type { FileInfo, RelPath } from '../shared/types.ts'

export interface FsClient {
  /** List one directory (one level), `path` defaults to the mount root. */
  list(path?: RelPath): Promise<FileInfo[]>
  /** Read a file as UTF-8 text; binary content rejects with `EBINARY`. */
  readText(path: RelPath): Promise<string>
  /** Read a file's bytes; binary content rejects with `EBINARY`. */
  readBytes(path: RelPath): Promise<Uint8Array>
}

interface ErrorBody {
  error?: { code?: string; message?: string }
}

async function failure(response: Response): Promise<never> {
  let body: ErrorBody | undefined
  try {
    body = (await response.json()) as ErrorBody
  } catch {
    body = undefined
  }
  const code = body?.error?.code
  if (code !== undefined && KNOWN_CODES.has(code)) {
    throw fsError(code as FsErrorCode, body?.error?.message)
  }
  throw fsError('EIO', body?.error?.message ?? `HTTP ${response.status} ${response.statusText}`)
}

const KNOWN_CODES = new Set<string>([
  'EINVAL', 'EIO', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EOUTSIDE', 'EBINARY',
])

/** Marker the server sets on refused binary files. */
export const BINARY_CODE = 'EBINARY' as const

type ContentResponse = { path: string; encoding: 'utf-8'; text: string }

/** Fetch the text contract of one file; returns raw text and bytes alike. */
async function fetchText(base: string, path: RelPath): Promise<ContentResponse> {
  const response = await fetch(`${base}/api/fs/read?path=${encodeURIComponent(path)}`)
  if (!response.ok) await failure(response)
  return (await response.json()) as ContentResponse
}

/** Create the fs face bound to one mount's base URL. */
export function createFsClient(base: string): FsClient {
  return {
    async list(path = '') {
      const response = await fetch(`${base}/api/fs/list?path=${encodeURIComponent(path)}`)
      if (!response.ok) await failure(response)
      const body = (await response.json()) as { entries: FileInfo[] }
      return body.entries
    },
    async readText(path) {
      return (await fetchText(base, path)).text
    },
    async readBytes(path) {
      return new TextEncoder().encode((await fetchText(base, path)).text)
    },
  }
}
