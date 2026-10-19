/**
 * Page-level data types. These are the shapes that cross the fs RPC boundary
 * and the props boundary between plugins, so they live in the shared layer and
 * never expose Node's `Dirent` / `Stats` (contract.md §3.1).
 */

/** Path relative to the mount root, `/`-separated, without a leading `/`. */
export type RelPath = string

/** One directory entry as the kernel sees it. */
export interface FileInfo {
  path: RelPath
  name: string
  kind: 'file' | 'dir'
  /** Bytes; `0` for directories. */
  size: number
  /** Milliseconds since epoch. */
  mtime: number
}

/**
 * An open tab (contract.md §3.4). It carries the path only: the content seat
 * stats and reads the file itself, so a changed file is re-read without the
 * tab service depending on `fs`.
 */
export interface TabInfo {
  id: string
  path: RelPath
}

/** A kernel-side file change notification (contract.md §3.1; emitted from M2). */
export interface FsWatchEvent {
  type: 'change' | 'add' | 'unlink'
  path: RelPath
}

/** Bytes `probe` matchers may look at (contract.md §5.1). */
export const PROBE_HEAD_BYTES = 4096

/**
 * The page module table record (docs/m0/spec.md §10.3, contract.md §8): a
 * namespace object per table specifier. The shell fills it; the server's
 * virtual table modules read it. Kept structural so the kernel needs no React.
 */
export interface DioramaTableRecord {
  [specifier: string]: Record<string, unknown> | undefined
}

declare global {
  // eslint-disable-next-line no-var
  var __diorama_table__: DioramaTableRecord | undefined
}
