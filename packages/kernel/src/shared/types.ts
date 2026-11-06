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

/**
 * The URL prefix of the mount's **raw bytes** (contract.md §4): a file URL is
 * `<origin>/~raw~/<RelPath>`.
 *
 * Two prefixes, two jobs, and they never collide: `/~/a.md` is the page that
 * *shows* `a.md`, `/~raw~/a.md` is `a.md` itself. The same reason as
 * {@link ROUTE_PREFIX} picks `~`: a file name cannot contain it, so a mount
 * directory called `raw` is still reachable at `/~raw~/raw/x` instead of being
 * shadowed by the route.
 */
export const RAW_PREFIX = '/~raw~/'

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

/** One repository a mount contains (contract.md §3.2, v0.10). */
export interface GitRepoInfo {
  /** The repository root as a mount-relative path (`''` = the mount root). */
  path: RelPath
  /**
   * The discovery walk stopped early (its depth/limit): the list is a prefix,
   * not every repository of the mount.
   */
  truncated?: boolean
}

/** One changed path of the working tree. */
export interface GitStatusEntry {
  file: RelPath
  kind: GitChangeKind
  /** Porcelain status (`M `, `??`, …), verbatim; callers must not parse it. */
  status: string
  /** `renamed` only: the path before the rename. */
  oldPath?: RelPath
  /** The repository this change belongs to (v0.10; `''` = the mount root). */
  repo?: RelPath
}

/** What a `diff()` call compares (contract.md §3.2). */
export interface DiffScope {
  /** Only this file. Absent = every change under `scope`. */
  path?: RelPath
  /** Only this directory subtree ('' = the mount root). */
  scope?: RelPath
  /**
   * Only this repository (v0.10). Absent = every repository of the mount; a
   * `path` decides its repository by itself.
   */
  repo?: RelPath
  /**
   * What to compare (v0.6): `'HEAD'` (working tree vs HEAD, default), `'index'`
   * (staged vs HEAD) or any revision git can resolve (working tree vs it).
   */
  base?: 'HEAD' | 'index' | string
}

/** One file's diff. */
export interface DiffEntry {
  file: RelPath
  kind: GitChangeKind
  status: string
  /** The repository this file belongs to (v0.10; `''` = the mount root). */
  repo?: RelPath
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
  /**
   * The parents' full shas, first parent first. A root commit has none
   * (`[]`). The history view draws its graph from these.
   */
  parents: string[]
}

/** One commit in full, with the files it touched (contract.md §3.2, v0.6). */
export interface CommitDetail {
  sha: string
  shortSha: string
  subject: string
  author: string
  /** The repository the commit is in (v0.10; `''` = the mount root). */
  repo?: RelPath
  /** ms since epoch. */
  at: number
  /** The whole commit message, verbatim (subject and body). */
  message: string
  /**
   * **Every** file the commit changed, shaped like `diff()` entries
   * (mount-relative). The list is never a prefix: a reader picks a file out of
   * it, so a missing row is a missing answer.
   */
  files: DiffEntry[]
  /**
   * Some entries carry no inline `text` because this call's diff budget
   * (4 MiB / 2000 lines) ran out — they are read one at a time when the reader
   * opens them (`show(commit, path)`). The **file list itself is complete**;
   * this flag says the call was big, not that rows were dropped.
   */
  truncated?: true
}

/**
 * A stretch of history to read the changes of (contract.md §3.2, v0.25): the
 * commits from `from` to `to`, **oldest first, both included**. It is not a
 * two-tree comparison — the "before" side is the oldest commit's **parent**, so
 * every picked commit's own change is part of the answer (a root commit is
 * compared with the empty tree).
 */
export interface CommitRange {
  /** The oldest picked commit: a sha or any revision git resolves. */
  from: string
  /** The newest picked commit. */
  to: string
}

/** The result of one `range()` call (contract.md §3.2, v0.25). */
export interface RangeResult {
  /** The **oldest** picked commit, as git resolved it (a full sha). */
  from: string
  /** The **newest** picked commit (a full sha). */
  to: string
  /**
   * **Every** file the two commits differ in, shaped like `diff()` entries
   * (mount-relative). Never a prefix — see `CommitDetail.files`.
   */
  files: DiffEntry[]
  /**
   * Some entries carry no inline `text` (this call's diff budget ran out);
   * they are read one at a time when the reader opens them.
   */
  truncated?: true
}

/** One file of one commit (contract.md §3.2, v0.6). */
export interface BlobResult {
  /** Text content; binary files have `binary: true` instead. */
  text?: string
  binary?: true
  /** Over the text limit (8 MiB): `text` is a prefix. */
  truncated?: true
  /** Size in bytes. */
  size: number
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
