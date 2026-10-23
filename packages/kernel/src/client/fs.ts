/**
 * Client half of `ctx.fs` (contract.md §3.1, §4): the browser-side face of the
 * per-mount fs service, obtained through the automatic RPC proxy.
 *
 * Shapes are identical to the server service — `list`, `stat`, `readText`,
 * `readBytes`, `watch` — so a plugin written against the server half keeps
 * working in the browser. The M0 HTTP transport (`/api/fs/*`) is gone.
 */
import type { FsWatchEvent, FileInfo, RelPath } from '../shared/types.ts'
import { SUBSCRIPTION_METHOD } from '../shared/rpc.ts'
import type { RpcClient } from './rpc.ts'

/** The contract's default watch window (contract.md §3.1). */
export const WATCH_DEBOUNCE_MS = 300

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
   * Watch a directory (contract.md §3.1). A subscription endpoint over RPC
   * (§4): the first events merge in the same 300ms windows as the server's.
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
    watch(path, listener) {
      let live = true
      const pending = new Map<string, FsWatchEvent>()
      const timers = new Map<string, ReturnType<typeof setTimeout>>()

      const deliver = (event: FsWatchEvent): void => {
        const key = `${event.type}:${event.path}`
        pending.set(key, event)
        const timer = timers.get(key)
        if (timer !== undefined) clearTimeout(timer)
        timers.set(key, setTimeout(() => {
          timers.delete(key)
          const next = pending.get(key)
          pending.delete(key)
          if (next !== undefined && live) listener(next)
        }, WATCH_DEBOUNCE_MS))
      }

      // The channel keeps this endpoint started across reconnects (contract.md
      // §4): a dropped network resumes the watch instead of silencing the tree.
      const unsubscribe = rpc.watchEndpoint(`fs.${SUBSCRIPTION_METHOD}`, [path], payload => deliver(payload as FsWatchEvent))

      return () => {
        if (!live) return
        live = false
        for (const timer of timers.values()) clearTimeout(timer)
        timers.clear()
        pending.clear()
        unsubscribe()
      }
    },
  }
}

export type { FileInfo, RelPath }
