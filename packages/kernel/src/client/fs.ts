/**
 * Client half of `ctx.fs` (contract.md §3.1, §4): the browser-side face of the
 * per-mount fs service, obtained through the automatic RPC proxy.
 *
 * Shapes are identical to the server service — `list`, `stat`, `readText`,
 * `readBytes`, `watch` — so a plugin written against the server half keeps
 * working in the browser. The M0 HTTP transport (`/api/fs/*`) is gone.
 */
import type { FsWatchEvent, FileInfo, RelPath } from '../shared/types.ts'
import type { RpcClient } from './rpc.ts'

/** The proxyable methods of the server's `FsService`. */
export const FS_METHODS = ['list', 'stat', 'readText', 'readBytes'] as const

export interface FsClient {
  /** List one directory (one level), `path` defaults to the mount root. */
  list(path?: RelPath): Promise<FileInfo[]>
  /** One path's info; same shape as a `list` element. */
  stat(path: RelPath): Promise<FileInfo>
  /** Read a file as UTF-8 text; binary content rejects with `EBINARY`. */
  readText(path: RelPath): Promise<string>
  /** Read a file's bytes; larger than the kernel limit rejects with `ETOOLARGE`. */
  readBytes(path: RelPath): Promise<Uint8Array>
  /**
   * Watch a path (contract.md §3.1). The signature is final; the transport for
   * events arrives with M2, so this registers nothing and returns the disposer.
   */
  watch(path: RelPath, listener: (event: FsWatchEvent) => void): () => void
}

/** Build the `mountCtx.fs` face over the RPC channel. */
export function createFsClient(rpc: RpcClient): FsClient {
  const remote = rpc.service<Omit<FsClient, 'watch'>>('fs', FS_METHODS)
  return {
    list: (path = '') => remote.list(path),
    stat: path => remote.stat(path),
    readText: path => remote.readText(path),
    readBytes: path => remote.readBytes(path),
    // Hooks into the same event channel the server will broadcast on in M2.
    watch(path, listener) {
      void path
      void listener
      return () => {}
    },
  }
}

export type { FileInfo, RelPath }
