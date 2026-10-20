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
  /**
   * What the tab shows (contract.md §3.4): `content` (the default, absent) is
   * the file itself; `diff` is its change in the working tree. Still no file
   * data: the reader is the content seat or the renderer the view routes to.
   */
  view?: 'content' | 'diff'
}

/** A kernel-side file change notification (contract.md §3.1; emitted from M2). */
export interface FsWatchEvent {
  type: 'change' | 'add' | 'unlink'
  path: RelPath
}

/**
 * The URL prefix of the page's own routes (contract.md §3.8): a `path` URL is
 * `<origin>/~/<RelPath>`. No file name can contain `~`, and every server route
 * (`/plugin.json`, `/assets/`, `/plugins/`, `/__diorama__/`) lives outside it.
 */
export const ROUTE_PREFIX = '/~/'

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

/**
 * The read-only git view (contract.md §3.2). Paths are relative to the mount
 * root, like every other path in the kernel (`RelPath`); the service converts
 * to repository paths itself.
 */
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

/** One changed path of the working tree. */
export interface GitStatusEntry {
  file: RelPath
  kind: GitChangeKind
  /** Porcelain status (`M `, `??`, …), verbatim; callers must not parse it. */
  status: string
  /** `renamed` only: the path before the rename. */
  oldPath?: RelPath
}

/** What a `diff()` call compares (contract.md §3.2). */
export interface DiffScope {
  /** Only this file. Absent = every change under `scope`. */
  path?: RelPath
  /** Only this directory subtree ('' = the mount root). */
  scope?: RelPath
  /** v0.5 accepts only `'HEAD'` (working tree vs HEAD); the default. */
  base?: 'HEAD'
}

/** One file's diff. */
export interface DiffEntry {
  file: RelPath
  kind: GitChangeKind
  status: string
  /** Unified diff text (`--no-color`); binary files have `binary: true` instead. */
  text?: string
  binary?: true
  oldPath?: RelPath
  /** The file's diff exceeded the limit: `text` is a prefix. */
  truncated?: true
}

/** The result of one `diff()` call. */
export interface DiffResult {
  /** Changes in order; one unreadable file does not fail the list. */
  entries: (DiffEntry | { file: RelPath; error: { code: string; message: string } })[]
  /** The whole call exceeded the limit (4 MiB / 2000 lines): a prefix was returned. */
  truncated: boolean
}

/** One commit as `log()` reports it. */
export interface GitLogEntry {
  sha: string
  shortSha: string
  subject: string
  author: string
  /** ms since epoch. */
  at: number
}

/**
 * One node of a changed-file tree (contract.md §3.2's flat `status()` rows,
 * folded by directory for the changes view). A directory's `path` is its
 * mount-relative path; `name` is its last segment.
 */
export interface ChangeTreeNode {
  kind: 'dir' | 'file'
  path: RelPath
  name: string
  /** Files at or below this node (a file node counts as 1). */
  count: number
  /** Root node: absent. The entry that changed, for a file node. */
  entry?: GitStatusEntry
  children?: ChangeTreeNode[]
}
