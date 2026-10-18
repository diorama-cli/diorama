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

/** An open tab. M0 keeps a single tab whose id is fixed. */
export interface TabInfo {
  id: string
  file: FileInfo
}

/**
 * The page module table record (docs/m0/spec.md §10.3): a namespace object per
 * table specifier. The shell fills it; the server's virtual table modules read
 * it. Kept structural so the kernel needs no React dependency.
 */
export interface DioramaTableRecord {
  [specifier: string]: Record<string, unknown> | undefined
}

declare global {
  // eslint-disable-next-line no-var
  var __diorama_table__: DioramaTableRecord | undefined
}
