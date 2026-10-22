/**
 * git — the repository's changes as a view of the left column, and a diff
 * renderer for the right (contract.md §3.2, §3.4, §5.2).
 *
 * One piece, two surfaces:
 * - `sidebar.views` / `key = 'changes'`: the changed files of the working tree
 *   (`ctx.git.status()`). Picking one opens it in a tab **in diff view**
 *   (`ctx.tabs.open(file, { view: 'diff' })`), like the file tree opens files.
 * - `seats.git-diff`: the seat a `view: 'diff'` tab draws its file in. The diff
 *   comes from `ctx.git.diff({ path })`, read here once per change.
 *
 * The tab's `view` decides *which seat* the `tabs` piece draws (contract.md
 * §3.4); this piece only fills the `diff` seat, so it never has to claim files
 * by path nor take a `file.renderer` slot away from the content renderers.
 *
 * Optional by contract: a mount outside a working tree has no `git` service
 * (contract.md §3.2). Then the changes view is not registered at all, and the
 * column shows only what is there.
 */
import type { Context } from 'cordis'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { ChangeTreeNode, CommitDetail, DiffEntry, DiffResult, FileInfo, GitLogEntry, GitStatusEntry } from 'diorama-kernel'
import { buildChangeTree, hasGit, type GitClient, type TabsService } from 'diorama-kernel/client'
import { FileIcon, Icon, iconSvg, provideEntry, useKernel } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'
import type { CommitSeatProps, TabDiffProps } from 'diorama-plugin-slots'
import {
  buildFileRows,
  buildSplitRows,
  collapseFileRows,
  collapseSplitRows,
  diffHunks,
  diffStat,
  labelHunks,
  parseDiff,
  splitLines,
  type DiffLine,
  type FileGap,
} from './model.ts'

export const name = 'git-changes'
export const inject = ['slots']

/** The switcher key of the changes view (contract.md §5.2). */
export const CHANGES_VIEW = 'changes'

/**
 * This piece's slot in the URL hash (contract.md §3.8): a **flag** meaning
 * "the active tab shows this file's diff". The file itself is the path
 * (`/~/<file>`), so the hash does not repeat it; a later base (`HEAD~1`) would
 * be this key's value. The kernel does not know what `diff` means.
 */
export const DIFF_HASH_KEY = 'diff'

/** The switcher key of the history view (contract.md §5.2, v0.6). */
export const HISTORY_VIEW = 'history'

/**
 * This piece's hash key for the history view (contract.md §3.8): the **value**
 * is the commit being looked at, or `''` for "the history view is open, no
 * commit picked yet". The kernel does not know what `history` means.
 *
 * A mount may hold several repositories (v0.10), and the same sha means
 * different commits in different repositories, so the value carries **both**:
 * `<repo>:<sha>` when the commit is in a repository below the mount root, and
 * the bare sha when it is in the mount's own repository (which is what every
 * v0.6–v0.9 URL already holds). Repository paths contain `/` but never `:`,
 * so the first `:` is the separator.
 */
export const HISTORY_HASH_KEY = 'history'

/** A history hash value split into its repository and commit. */
export interface PickedCommit {
  /** The repository's mount-relative path (`''` = the mount's own repository). */
  repo: string
  /** The commit, as the history row spells it (a full sha). */
  commit: string
}

/** Encode a picked commit for `#history` (see {@link HISTORY_HASH_KEY}). */
export function historyHashValue(repo: string, commit: string): string {
  return repo === '' ? commit : `${repo}:${commit}`
}

/** Decode a `#history` value; `undefined` for the empty (or absent) value. */
export function parseHistoryHash(value: string | undefined): PickedCommit | undefined {
  if (value === undefined || value === '') return undefined
  const at = value.indexOf(':')
  if (at <= 0) return { repo: '', commit: value }
  return { repo: value.slice(0, at), commit: value.slice(at + 1) }
}

/** The changes view's switcher icon (docs/m7/spec.md §3: the button table). */
export const CHANGES_ICON = iconSvg('git-changes')

/** The history view's switcher icon. */
export const HISTORY_ICON = iconSvg('git-history')

/** Kind → the badge shown in the changes list (VS Code's letters). */
const BADGE: Record<GitStatusEntry['kind'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
}

/** Where a status entry's badge goes, colour-wise. */
export const TONE: Record<GitStatusEntry['kind'], string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'modified',
  untracked: 'untracked',
  conflicted: 'conflicted',
}

/** Directory events that mean "the working tree may have changed". */
type ChangeEvent = { type: 'change' | 'add' | 'unlink'; path: string }

/** A file-system event → a `git status` re-read, at most this often (ms). */
const RECHECK_MS = 400

/**
 * Changed files of the working tree: fetched on mount, then re-fetched when
 * the directory changes.
 *
 * `ctx.git` has no subscription endpoint (contract.md §3.2), so the signal
 * comes from `ctx.fs.watch` (§3.1): every directory the file tree shows is
 * watched one level deep, and any event schedules one `status()` after a
 * short quiet period — a burst of saves is one re-read, not one each. A
 * directory appears/disappears on its own event, so the watch set follows the
 * tree. The list also has its own button for when a watch was refused (the
 * per-mount `maxDirectories` cap) or unavailable.
 */
function useChanges(mount: { git: GitClient; fs: { list(path?: string): Promise<{ path: string; kind: string }[]>; watch(path: string, listener: (event: ChangeEvent) => void): () => void } }): {
  entries: GitStatusEntry[] | undefined
  error: string | undefined
  reload(): void
} {
  const [state, setState] = useState<{ entries?: GitStatusEntry[]; error?: string }>({})
  const [epoch, setEpoch] = useState(0)
  const git = mount.git
  useEffect(() => {
    let live = true
    const load = (): void => {
      git.status().then(
        entries => {
          if (live) setState({ entries })
        },
        (error: unknown) => {
          if (live) setState({ error: error instanceof Error ? error.message : String(error) })
        },
      )
    }
    load()

    // One timer per burst: the next event restarts it, so a save storm from an
    // editor is a single `status()` once the tree stops moving.
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        load()
      }, RECHECK_MS)
    }
    const watchers = new Map<string, () => void>()
    const watched = new Set<string>()
    const refreshWatches = (): void => {
      mount.fs.list('').then(
        entries => {
          if (!live) return
          const dirs = new Set(['', ...entries.filter(entry => entry.kind === 'dir').map(entry => entry.path)])
          for (const [dir, dispose] of watchers) {
            if (dirs.has(dir)) continue
            dispose()
            watchers.delete(dir)
            watched.delete(dir)
          }
          for (const dir of dirs) {
            if (watchers.has(dir)) continue
            watched.add(dir)
            watchers.set(
              dir,
              mount.fs.watch(dir, event => {
                // `type` is a hint, not the truth (contract.md §3.1): an added
                // path may be a directory that needs its own watch, and only
                // `list` can tell. The rescan is idempotent and only adds
                // watchers for directory names it did not see before.
                if (event.type === 'add') refreshWatches()
                schedule()
              }),
            )
          }
        },
        () => {},
      )
    }
    refreshWatches()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
      for (const dispose of watchers.values()) dispose()
      watchers.clear()
    }
  }, [git, mount, epoch])
  return {
    entries: state.entries,
    error: state.error,
    reload: () => setEpoch(value => value + 1),
  }
}

/** One row of the changes list; clicking opens the file in diff view. */
function ChangeRow({
  entry,
  selected,
  indent,
  onOpen,
}: {
  entry: GitStatusEntry
  selected: boolean
  /** Left padding from the tree depth (the row is drawn inside the tree). */
  indent?: { paddingLeft: number }
  onOpen(entry: GitStatusEntry): void
}) {
  const name = entry.file.slice(entry.file.lastIndexOf('/') + 1)
  return (
    <button
      type="button"
      className={`diorama-changes__row${selected ? ' diorama-changes__row--selected' : ''}`}
      data-path={entry.file}
      data-kind={entry.kind}
      title={entry.oldPath === undefined ? entry.file : `${entry.oldPath} → ${entry.file}`}
      style={indent}
      onClick={() => onOpen(entry)}
    >
      <FileIcon name={name} />
      <span className={`diorama-changes__badge diorama-changes__badge--${TONE[entry.kind]}`} aria-hidden="true">
        {BADGE[entry.kind]}
      </span>
      <span className="diorama-changes__name">{name}</span>
      {entry.oldPath === undefined ? null : <span className="diorama-changes__dir">← {entry.oldPath}</span>}
    </button>
  )
}

/** A `FileInfo` for a path (the tab only carries the path, contract.md §3.4). */
function diffFile(path: string): FileInfo {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 0, mtime: 0 }
}

/** The active tab's path (the changes list highlights it); `undefined` without tabs. */
function useTabPath(tabs: TabsService | undefined): string | undefined {
  const subscribe = useMemo<(listener: () => void) => () => void>(
    () => (listener: () => void) => (tabs === undefined ? () => {} : tabs.subscribe(listener)),
    [tabs],
  )
  const read = (): string | undefined => tabs?.active?.path
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * One repository's group in the changes view (v0.10): a foldable header naming
 * the repository, then that repository's own tree. A mount with a single
 * repository rooted at the mount has no header — the group would only repeat
 * what the column already is.
 */
function RepoGroup({
  repo,
  entries,
  selected,
  open,
  collapsed,
  onToggle,
  showHeader,
}: {
  repo: string
  entries: readonly GitStatusEntry[]
  selected: string | undefined
  open(entry: GitStatusEntry): void
  collapsed: ReadonlySet<string>
  onToggle(key: string): void
  showHeader: boolean
}) {
  const key = `repo:${repo}`
  const closed = collapsed.has(key)
  const label = repo === '' ? '(挂载目录)' : repo
  return (
    <div className="diorama-changes__repo" data-repo={repo} data-testid="git-changes-repo">
      {showHeader ? (
        <button
          type="button"
          className="diorama-changes__repo-head"
          aria-expanded={!closed}
          title={repo === '' ? '仓库根就是挂载目录' : repo}
          onClick={() => onToggle(key)}
        >
          <span className="diorama-tree__caret" aria-hidden="true">
            <Icon name={closed ? 'caret-right' : 'caret-down'} size={14} />
          </span>
          <FileIcon name={label} kind="dir" expanded={!closed} />
          <span className="diorama-changes__repo-name">{label}</span>
          <span className="diorama-changes__count">{entries.length}</span>
        </button>
      ) : null}
      {closed ? null : <ChangeTree entries={entries} selected={selected} onOpen={open} />}
    </div>
  )
}

/** The changes view (contract.md §5.2). */
function ChangesView({ active }: { active: boolean }) {
  const { mount, ctx } = useKernel()
  const tabs = ctx.tabs as TabsService | undefined
  const changes = useChanges(mount)
  const activeTab = useTabPath(tabs)
  const router = ctx.router
  // Repository groups fold like directories do; the state is this view's own.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  void active
  if (changes.error !== undefined) {
    return (
      <div className="diorama-changes" data-testid="git-changes" role="alert">
        {changes.error}
      </div>
    )
  }
  if (changes.entries === undefined) {
    return (
      <div className="diorama-changes" data-testid="git-changes">
        正在读取变更…
      </div>
    )
  }
  if (changes.entries.length === 0) {
    return (
      <div className="diorama-changes diorama-changes__empty" data-testid="git-changes" role="status">
        工作区没有改动
      </div>
    )
  }
  const open = (entry: GitStatusEntry): void => {
    if (tabs === undefined) return
    // A tab is keyed by `(path, view)` (contract.md §3.4): the diff gets its
    // own tab next to the content one, rather than replacing it. The diff tab
    // is active, so the router puts its file in the path; the hash only says
    // *which view* (`#diff`, a flag) — the file is not repeated there.
    tabs.open(diffFile(entry.file), { view: 'diff' })
    router?.state(DIFF_HASH_KEY).set('')
  }
  // One group per repository, in the order the service reports them
  // (shallowest first, contract.md §3.2).
  const groups: { repo: string; entries: GitStatusEntry[] }[] = []
  for (const entry of changes.entries) {
    const repo = entry.repo ?? ''
    const last = groups[groups.length - 1]
    if (last !== undefined && last.repo === repo) last.entries.push(entry)
    else groups.push({ repo, entries: [entry] })
  }
  const showHeaders = groups.length > 1
  return (
    <div className="diorama-changes" data-testid="git-changes">
      <div className="diorama-changes__group">
        <span>
          {changes.entries.length} 个改动
          {groups.length > 1 ? ` · ${groups.length} 个仓库` : ''}
        </span>
        <button
          type="button"
          className="diorama-changes__reload"
          data-testid="git-changes-reload"
          title="刷新变更列表"
          aria-label="刷新变更列表"
          onClick={changes.reload}
        >
          <Icon name="reload" size={14} />
        </button>
      </div>
      {groups.map(group => (
        <RepoGroup
          key={group.repo}
          repo={group.repo}
          entries={group.entries}
          selected={activeTab}
          open={open}
          collapsed={collapsed}
          onToggle={toggle}
          showHeader={showHeaders}
        />
      ))}
    </div>
  )
}

/**
 * The changed files as a tree, the way an editor shows them (contract.md §3.2,
 * §5.2): directories fold, a single-child chain becomes one row, and the
 * expansion is this view's own state — the file tree's expansion is separate.
 */
function ChangeTree({
  entries,
  selected,
  onOpen,
}: {
  entries: readonly GitStatusEntry[]
  selected: string | undefined
  onOpen(entry: GitStatusEntry): void
}) {
  const tree = useMemo(() => buildChangeTree(entries), [entries])
  // A new set of changes starts fully expanded: seeing every change matters
  // more than remembering a collapse from an earlier session.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (path: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  return (
    <div className="diorama-changes__tree">
      {(tree.children ?? []).map(child => (
        <ChangeNode key={child.path} node={child} depth={0} collapsed={collapsed} onToggle={toggle} selected={selected} onOpen={onOpen} />
      ))}
    </div>
  )
}

/** One tree row: a directory (caret, count) or a file (status badge). */
function ChangeNode({
  node,
  depth,
  collapsed,
  onToggle,
  selected,
  onOpen,
}: {
  node: ChangeTreeNode
  depth: number
  collapsed: ReadonlySet<string>
  onToggle(path: string): void
  selected: string | undefined
  onOpen(entry: GitStatusEntry): void
}) {
  const indent = { paddingLeft: 8 + depth * 14 }
  if (node.kind === 'file') {
    const entry = node.entry
    if (entry === undefined) return null
    return (
      <ChangeRow
        entry={entry}
        selected={entry.file === selected}
        indent={indent}
        onOpen={onOpen}
      />
    )
  }
  const closed = collapsed.has(node.path)
  return (
    <>
      <button
        type="button"
        className="diorama-tree__row diorama-changes__dir"
        style={indent}
        data-path={node.path}
        data-kind="dir"
        aria-expanded={!closed}
        title={node.path}
        onClick={() => onToggle(node.path)}
      >
        <span className="diorama-tree__caret" aria-hidden="true">
          <Icon name={closed ? 'caret-right' : 'caret-down'} size={14} />
        </span>
        <FileIcon name={node.name} kind="dir" expanded={!closed} />
        <span className="diorama-tree__name">{node.name}/</span>
        <span className="diorama-changes__count">{node.count}</span>
      </button>
      {!closed &&
        (node.children ?? []).map(child => (
          <ChangeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            collapsed={collapsed}
            onToggle={onToggle}
            selected={selected}
            onOpen={onOpen}
          />
        ))}
    </>
  )
}

/**
 * An untracked file has no diff (git never compares it): show the whole file
 * as an addition. The bytes come from `ctx.fs` — a diff reader may read the
 * file it shows (contract.md §5.1), and `ctx.git` only reports the change.
 */
async function synthesizeAddition(
  mount: { fs: { stat(path: string): Promise<FileInfo>; readText(path: string): Promise<string>; readBytes(path: string): Promise<Uint8Array> } },
  file: string,
): Promise<{ lines: string[]; notes: string[]; truncated: boolean }> {
  let info: FileInfo
  try {
    info = await mount.fs.stat(file)
  } catch (error) {
    return { lines: [], notes: [`读取失败：${(error as Error).message}`], truncated: false }
  }
  // Only text can be shown as lines; anything else (or too large) keeps the note.
  if (info.size > MAX_UNTRACKED_BYTES) {
    return { lines: [], notes: [`文件过大（${formatBytes(info.size)}），不展开未跟踪文件的内容`], truncated: false }
  }
  let text: string
  try {
    text = await mount.fs.readText(file)
  } catch (error) {
    if ((error as { code?: string }).code !== 'EBINARY') {
      return { lines: [], notes: [`读取失败：${(error as Error).message}`], truncated: false }
    }
    // Binary: at least say how big it is instead of pretending to be empty.
    return { lines: [], notes: [`二进制文件（${formatBytes(info.size)}），不展开内容`], truncated: false }
  }
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const notes = [`新文件：未纳入版本库，下面是整个文件（${lines.length} 行）`]
  if (lines.length > MAX_UNTRACKED_LINES) {
    return { lines: lines.slice(0, MAX_UNTRACKED_LINES), notes: [...notes, `超过 ${MAX_UNTRACKED_LINES} 行，已截断`], truncated: true }
  }
  return { lines, notes, truncated: false }
}

/**
 * The diff of a file that has none: every line an addition, in the one-hunk
 * form git itself would print for a new file. The readers need a diff (they
 * parse it), and "the whole file is new" is exactly that.
 */
export function additionDiff(lines: readonly string[]): string {
  if (lines.length === 0) return ''
  return ['@@ -0,0 +1,' + lines.length + ' @@', ...lines.map(line => `+${line}`)].join('\n')
}

/** Bytes of an untracked file shown in full (above this, say how big it is). */
export const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

/** Lines of an untracked file shown in full. */
export const MAX_UNTRACKED_LINES = 5000

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * The whole file, for the "whole file" mode: its text as it is now, plus why it
 * cannot be shown when it cannot (a binary, a file over the read limit).
 */
type FileState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'note'; note: string }
  /** The path is not there (the old side of a file that has just been added). */
  | { status: 'missing' }

/**
 * Read one file of this mount for a reader that shows file content (the
 * whole-file and side-by-side modes).
 *
 * `ctx.fs` is the only way to read a file (contract.md §5.1: a reader may read
 * the file it shows). A binary or oversized file is a **note**, not an error:
 * the diff is still readable, and "cannot show this side" is one line.
 *
 * `missing` is a path that is not there at all (the old side of a file the
 * working tree has only just gained): that is not a note, it is an empty side,
 * and the caller decides what to say.
 */
function useFileText(path: string | undefined, wanted: boolean): FileState {
  const { mount } = useKernel()
  const [state, setState] = useState<FileState>({ status: 'idle' })
  useEffect(() => {
    if (!wanted || path === undefined) {
      setState({ status: 'idle' })
      return
    }
    let live = true
    setState({ status: 'loading' })
    mount.fs.stat(path).then(
      info => {
        if (!live) return
        if (info.size > MAX_UNTRACKED_BYTES) {
          setState({ status: 'note', note: `文件过大（${formatBytes(info.size)}），只显示改动` })
          return
        }
        return mount.fs.readText(path).then(
          text => {
            if (live) setState({ status: 'ready', text })
          },
          (error: unknown) => {
            if (!live) return
            const code = (error as { code?: string }).code
            if (code === 'EBINARY') setState({ status: 'note', note: `二进制文件（${formatBytes(info.size)}），只显示改动` })
            else setState({ status: 'note', note: `读取失败：${(error as Error).message}` })
          },
        )
      },
      (error: unknown) => {
        if (!live) return
        const code = (error as { code?: string }).code
        // A path that is gone (or never was) is an empty side, not a failure.
        if (code === 'ENOENT') setState({ status: 'missing' })
        else setState({ status: 'note', note: `读取失败：${(error as Error).message}` })
      },
    )
    return () => {
      live = false
    }
  }, [mount, path, wanted])
  return state
}

/**
 * How a diff is read (three ways, one button each):
 *
 * - `inline` — the unified diff alone (what git prints);
 * - `file` — the file with the change laid into it, one column;
 * - `split` — the old file beside the new one, the change in both.
 */
export type DiffMode = 'inline' | 'file' | 'split'

/** Where the choice is remembered (`localStorage`, like the theme's). */
export const DIFF_MODE_STORAGE_KEY = 'diorama.git.diffMode'

/** The three modes, in the order the buttons show them. */
export const DIFF_MODES: readonly DiffMode[] = ['inline', 'file', 'split']

/** The remembered mode; anything unrecognised is `inline` (the old behaviour). */
export function readDiffMode(): DiffMode {
  try {
    const stored = globalThis.localStorage?.getItem(DIFF_MODE_STORAGE_KEY)
    return DIFF_MODES.find(mode => mode === stored) ?? 'inline'
  } catch {
    return 'inline'
  }
}

/** Remember the mode. A blocked storage just means it does not survive a reload. */
export function storeDiffMode(mode: DiffMode): void {
  try {
    globalThis.localStorage?.setItem(DIFF_MODE_STORAGE_KEY, mode)
  } catch {
    // Nothing to do: the choice still applies to this page.
  }
}

/**
 * The diff's mode, shared by every diff surface of this piece (the working-tree
 * tab and the commit seat). One client half draws both, so a module-level store
 * is already shared state — the page global is only needed across *halves*
 * (docs/m4/spec.md §6.2 trap 13).
 */
const MODE_LISTENERS = new Set<() => void>()
let modeState: DiffMode | undefined

function diffModeState(): DiffMode {
  modeState ??= readDiffMode()
  return modeState
}

/** Subscribe to the mode (for `useSyncExternalStore`). */
export function subscribeDiffMode(listener: () => void): () => void {
  MODE_LISTENERS.add(listener)
  return () => {
    MODE_LISTENERS.delete(listener)
  }
}

/** The mode right now (a primitive: `useSyncExternalStore` needs a stable read). */
export function diffModeSnapshot(): DiffMode {
  return diffModeState()
}

/** Switch every diff surface of the page to `mode`. */
export function setDiffMode(mode: DiffMode): void {
  if (diffModeState() === mode) return
  modeState = mode
  storeDiffMode(mode)
  for (const listener of [...MODE_LISTENERS]) listener()
}

/** The mode, as a component reads it. */
export function useDiffMode(): DiffMode {
  return useSyncExternalStore(subscribeDiffMode, diffModeSnapshot, diffModeSnapshot)
}

/**
 * Move between the changes of one diff: the toolbar's arrows, and the arrow
 * keys while the reader has focus. `-1` means "nothing picked yet"; the first
 * `next` lands on the first change, the first `previous` on the last one.
 */
function useHunkNav(count: number): { cursor: number; next(): void; previous(): void } {
  const [cursor, setCursor] = useState(-1)
  const step = useCallback(
    (delta: number): void => {
      setCursor(current => {
        if (count === 0) return -1
        // Nothing picked yet: forward starts at the first change, backward at
        // the last one. After that it **wraps**, like every "find next" there
        // is: from the last change, "next" is the first one, not a dead arrow.
        if (current < 0) return delta > 0 ? 0 : count - 1
        return (current + delta + count) % count
      })
    },
    [count],
  )
  return { cursor, next: () => step(1), previous: () => step(-1) }
}

type DiffState = { status: 'loading' } | { status: 'ready'; result: DiffResult } | { status: 'error'; error: string }
/** The whole-content view of an untracked (or not yet committed) file. */
type AddedState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; lines: string[]; notes: string[]; truncated: boolean }

/** A `view: 'diff'` tab's content: one file's diff (contract.md §3.4, §5.2). */
function TabDiff({ tab }: TabDiffProps) {
  const { mount } = useKernel()
  const [state, setState] = useState<DiffState>({ status: 'loading' })
  const [added, setAdded] = useState<AddedState>({ status: 'idle' })
  const [epoch, setEpoch] = useState(0)
  // Both hooks run before any early return: a tab that starts loading and ends
  // up with an entry must not change the number of hooks between renders.
  const mode = useDiffMode()
  // The same mount-relative path may exist in several repositories of the
  // mount (v0.10): the tab's entry is the one whose repository it was opened
  // from. The diff call is scoped by path, so the service resolves that
  // repository itself; here the lookup only has to prefer the same one.
  const entry = state.status === 'ready'
    ? state.result.entries.find(item => item.file === tab.path) ?? state.result.entries[0]
    : undefined
  const usable = entry !== undefined && !('error' in entry)
  const binary = usable && entry.binary === true
  // The file itself is read only when a mode that shows file content is on
  // (and only for text). The two-column reader wants the old side as well:
  // the index's copy of the path, which is what the change was compared with.
  const file = useFileText(tab.path, mode !== 'inline' && usable && !binary)
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    setAdded({ status: 'idle' })
    mount.git.diff({ path: tab.path }).then(
      result => {
        if (!live) return
        setState({ status: 'ready', result })
        // No diff text and nothing committed to compare: this is a new file.
        // Read it (whole) so the tab shows its content instead of a note.
        const entry = result.entries.find(item => item.file === tab.path)
        const needsContent =
          entry !== undefined &&
          !('error' in entry) &&
          entry.text === undefined &&
          (entry.kind === 'untracked' || entry.kind === 'added')
        if (!needsContent) return
        setAdded({ status: 'loading' })
        void synthesizeAddition(mount, tab.path).then(
          whole => {
            if (live) setAdded({ status: 'ready', ...whole })
          },
          (error: unknown) => {
            if (live) setAdded({ status: 'ready', lines: [], notes: [`读取失败：${(error as Error).message}`], truncated: false })
          },
        )
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [mount, tab.path, epoch])
  if (state.status === 'loading') {
    return (
      <div className="diorama-renderer" data-testid="git-diff-loading">
        正在读取改动…
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="diorama-renderer diorama-renderer__error" role="alert" data-testid="git-diff-error">
        {state.error}
      </div>
    )
  }
  const notes: string[] = []
  // A file git has never compared has no diff text: the reader synthesised an
  // addition out of its content, and that is the diff both modes draw.
  const synthesized = usable && entry.text === undefined && !binary && added.status === 'ready' ? additionDiff(added.lines) : ''
  if (synthesized !== '' && added.status === 'ready') notes.push(...added.notes)
  return (
    <DiffView
      path={tab.path}
      kind={usable ? entry.kind : undefined}
      oldPath={usable ? entry.oldPath : undefined}
      diff={usable ? (entry.text ?? synthesized) : ''}
      binary={binary}
      error={entry === undefined ? { code: 'ENODIFF', message: '这个文件没有未提交的改动' } : 'error' in entry ? entry.error : undefined}
      truncated={usable && entry.truncated === true}
      callTruncated={state.result.truncated}
      notes={notes}
      loading={usable && !binary && entry.text === undefined && added.status === 'loading'}
      whole={file}
      onRefresh={() => setEpoch(value => value + 1)}
      testIds={{
        root: 'git-diff',
        text: 'git-diff-text',
        notes: 'git-diff-notes',
        empty: 'git-diff-empty',
        error: 'git-diff-error',
        loading: 'git-diff-loading',
        modeInline: 'git-diff-mode-inline',
        modeFile: 'git-diff-mode-file',
        modeSplit: 'git-diff-mode-split',
      }}
    />
  )
}

/** Test hooks: the working-tree tab and the commit seat differ only in these. */
interface DiffTestIds {
  root: string
  text: string
  notes: string
  empty: string
  error: string
  loading: string
  /** The three mode buttons (a page can show more than one diff surface). */
  modeInline: string
  modeFile: string
  modeSplit: string
}

/** What one diff surface knows before any mode is applied. */
interface DiffViewProps {
  /** The file, mount-relative. */
  path: string
  /** Its change kind (a badge); absent when there is no entry to show. */
  kind: GitStatusEntry['kind'] | undefined
  oldPath?: string
  /** The unified diff text; `''` when there is none (untracked, binary, no change). */
  diff: string
  binary: boolean
  /** The entry could not be read (`{code, message}`), or there is nothing to show. */
  error: { code: string; message: string } | undefined
  /** This file's diff was clipped by the service's per-file limit. */
  truncated: boolean
  /** The whole `diff()` call hit its limit: other files are missing from it. */
  callTruncated: boolean
  notes: readonly string[]
  /** A read is still in flight (an untracked file's content). */
  loading: boolean
  /**
   * The file's text as it is now: both the whole-file and the side-by-side
   * reader need it (the left column of the split takes its unchanged lines
   * from the same file — see `buildSplitRows`).
   */
  whole: FileState
  /** Re-read the change; absent where there is nothing to re-read (a commit). */
  onRefresh?(): void
  testIds: DiffTestIds
}

/**
 * One file's change, in the three ways to read it (v0.10):
 *
 * - **inline** — the unified diff, as git prints it. The default, and the only
 *   mode that always works (a binary file, an oversized file, a deletion);
 * - **whole file** — the file itself with the changes laid into it, one column,
 *   so the reader sees the code around a change (`ctx.fs.readText`);
 * - **split** — the old file beside the new one, the change shown in both
 *   columns (the deletions on the left, the insertions on the right).
 *
 * The mode is shared by every diff surface of the piece and remembered across
 * reloads; the choice of *which change to look at* is per surface, because it
 * is about this file.
 */
function DiffView({
  path,
  kind,
  oldPath,
  diff,
  binary,
  error,
  truncated,
  callTruncated,
  notes,
  loading,
  whole,
  onRefresh,
  testIds,
}: DiffViewProps) {
  const mode = useDiffMode()
  const rows = useMemo(() => parseDiff(diff), [diff])
  const stat = useMemo(() => diffStat(rows), [rows])
  const hunks = useMemo(() => diffHunks(rows), [rows])
  const nav = useHunkNav(hunks.length)
  const scroller = useRef<HTMLDivElement | null>(null)
  // A mode that shows file content needs the file, and cannot show what it
  // does not have: a binary, an unreadable file, a note all fall back to the
  // inline reader rather than a blank column.
  const contentMode = mode !== 'inline' && error === undefined && !binary && whole.status !== 'note'
  const lines = splitLines(diff)

  // Scrolling to the picked change: inline mode has the `@@` row's index, the
  // other two have the change's first row. Both are row indexes, so all three
  // views scroll the same way (the rows are direct children of the scroller).
  const target = mode !== 'inline' ? undefined : hunks[nav.cursor]?.row
  useEffect(() => {
    if (target === undefined) return
    const element = scroller.current?.children[target]
    if (element === undefined) return
    ;(element as HTMLElement).scrollIntoView({ block: 'center' })
  }, [target])

  // Arrow keys walk the changes while the reader's focus is in this surface.
  // Registered on the scroller, not on the page: two diffs (a tab and a commit
  // seat) must not answer the same key at the same time.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (hunks.length === 0) return
    event.preventDefault()
    if (event.key === 'ArrowDown') nav.next()
    else nav.previous()
  }

  const headerNotes: string[] = []
  if (binary) headerNotes.push('二进制文件：git 不提供文本 diff')
  if (truncated) headerNotes.push('这个文件的 diff 过大，已截断')
  if (callTruncated) headerNotes.push('改动过多，只显示了一部分')
  if (oldPath !== undefined) headerNotes.push(`由 ${oldPath} 改名`)
  headerNotes.push(...notes)

  return (
    <div className="diorama-diff" data-testid={testIds.root} data-kind={kind} data-mode={mode}>
      <div className="diorama-diff__header">
        {kind === undefined ? null : (
          <span className={`diorama-changes__badge diorama-changes__badge--${TONE[kind]}`} aria-hidden="true">
            {BADGE[kind]}
          </span>
        )}
        <FileIcon name={path.slice(path.lastIndexOf('/') + 1)} />
        <span className="diorama-diff__path">{path}</span>
        {stat.hunks > 0 && (
          <span className="diorama-diff__stat" data-testid="git-diff-stat" title={`${stat.hunks} 处改动`}>
            <span className="diorama-diff__stat-add">+{stat.added}</span>
            <span className="diorama-diff__stat-del">−{stat.removed}</span>
          </span>
        )}
        <ModeSwitch mode={mode} ids={testIds} />
        {hunks.length > 0 && (
          <span className="diorama-diff__nav" role="group" aria-label="在改动之间移动">
            <button
              type="button"
              className="diorama-diff__nav-button"
              title="上一处改动（↑）"
              aria-label="上一处改动"
              data-testid="git-diff-previous"
              onClick={nav.previous}
            >
              <Icon name="caret-up" size={14} />
            </button>
            <span className="diorama-diff__nav-count" data-testid="git-diff-hunk-count">
              {nav.cursor < 0 ? `${hunks.length} 处改动` : `${nav.cursor + 1} / ${hunks.length}`}
            </span>
            <button
              type="button"
              className="diorama-diff__nav-button"
              title="下一处改动（↓）"
              aria-label="下一处改动"
              data-testid="git-diff-next"
              onClick={nav.next}
            >
              <Icon name="caret-down" size={14} />
            </button>
          </span>
        )}
        {onRefresh !== undefined && (
          <button
            type="button"
            className="diorama-diff__reload"
            title="重新读取这个文件"
            aria-label="重新读取这个文件"
            onClick={onRefresh}
          >
            <Icon name="reload" size={14} />
          </button>
        )}
      </div>
      {headerNotes.length > 0 && (
        <div className="diorama-diff__notes" role="status" data-testid={testIds.notes}>
          {headerNotes.join('；')}
        </div>
      )}
      {error !== undefined && (
        <div className={error.code === 'ENODIFF' ? 'diorama-renderer__empty' : 'diorama-renderer__error'} role={error.code === 'ENODIFF' ? 'status' : 'alert'} data-testid={error.code === 'ENODIFF' ? testIds.empty : testIds.error}>
          {error.code === 'ENODIFF' ? error.message : `${error.code}: ${error.message}`}
        </div>
      )}
      {error === undefined && loading && lines.length === 0 && (
        <div className="diorama-renderer" data-testid={testIds.loading}>
          正在读取文件…
        </div>
      )}
      {contentMode && whole.status === 'loading' && (
        <div className="diorama-renderer" data-testid={testIds.loading}>
          正在读取整个文件…
        </div>
      )}
      {contentMode && whole.status === 'ready' && mode === 'file' && (
        <WholeFile diff={diff} text={whole.text} testId={testIds.text} />
      )}
      {contentMode && whole.status === 'ready' && mode === 'split' && (
        <SplitFile diff={diff} text={whole.text} testId={testIds.text} />
      )}
      {!contentMode && whole.status === 'note' && (
        <div className="diorama-diff__notes" role="status" data-testid="git-diff-file-note">
          {whole.note}
        </div>
      )}
      {(!contentMode || (whole.status !== 'ready' && whole.status !== 'loading')) && error === undefined && lines.length > 0 && (
        <div
          className="diorama-diff__text"
          data-testid={testIds.text}
          ref={scroller}
          role="group"
          aria-label="改动"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          <InlineRows rows={rows} />
        </div>
      )}
    </div>
  )
}

/** The inline reader: the unified diff, one row per line, with a gutter. */
function InlineRows({ rows }: { rows: readonly DiffLine[] }) {
  return (
    <>
      {rows.map((row, index) => (
        <div
          key={index}
          className={`diorama-diff__line diorama-diff__line--${row.tone}`}
          data-tone={row.tone}
          data-line={row.newLine ?? row.oldLine}
        >
          <span className="diorama-diff__num" aria-hidden="true">
            {row.oldLine ?? ''}
          </span>
          <span className="diorama-diff__num" aria-hidden="true">
            {row.newLine ?? ''}
          </span>
          <span className="diorama-diff__code">{row.text === '' ? '\u00a0' : row.text}</span>
        </div>
      ))}
    </>
  )
}

/** The whole-file reader: the file with the changes laid in, long runs folded. */
function WholeFile({ diff, text, testId }: { diff: string; text: string; testId: string }) {
  const rows = useMemo(() => buildFileRows(text, diff), [text, diff])
  const [open, setOpen] = useState<number | undefined>(undefined)
  const body = useMemo(() => labelHunks(collapseFileRows(rows, 3, 2, open), diff), [rows, diff, open])
  // A run of unchanged lines *after* the last change has no row to sit in
  // front of, so it is drawn once more after the last row.
  const trailing = body.gaps.get(body.rows.length)
  return (
    <div className="diorama-diff__text" data-testid={testId} data-mode="file" role="group" aria-label="整个文件">
      {body.rows.map((row, index) => {
        const gap = body.gaps.get(index)
        if (gap !== undefined) {
          return (
            <button
              key={`gap-${index}`}
              type="button"
              className="diorama-diff__gap"
              data-testid="git-diff-gap"
              title={`展开第 ${gap.from}–${gap.to} 行`}
              onClick={() => setOpen(gap.openedBy)}
            >
              <Icon name="unfold" size={13} />
              <span>
                {gap.count} 行未改动（第 {gap.from}–{gap.to} 行）
              </span>
            </button>
          )
        }
        return (
          <div
            key={index}
            className={`diorama-diff__line diorama-diff__line--${row.tone}`}
            data-tone={row.tone}
            data-line={row.number ?? row.oldNumber}
          >
            <span className="diorama-diff__num" aria-hidden="true">
              {row.oldNumber ?? ''}
            </span>
            <span className="diorama-diff__num" aria-hidden="true">
              {row.number ?? ''}
            </span>
            <span className="diorama-diff__code">{row.text === '' ? '\u00a0' : row.text}</span>
          </div>
        )
      })}
      {trailing !== undefined && (
        <button
          type="button"
          className="diorama-diff__gap"
          data-testid="git-diff-gap"
          title={`展开第 ${trailing.from}–${trailing.to} 行`}
          onClick={() => setOpen(trailing.openedBy)}
        >
          <Icon name="unfold" size={13} />
          <span>
            {trailing.count} 行未改动（第 {trailing.from}–{trailing.to} 行）
          </span>
        </button>
      )}
    </div>
  )
}

/**
 * The side-by-side reader: the old file on the left, the new one on the right,
 * the change shown in both (deletions on the left, insertions on the right).
 *
 * Both columns come from **one** read of the file: an unchanged line is the
 * same text on either side, so only its number differs (`buildSplitRows`).
 * Long runs of unchanged lines fold into one band across the two columns, the
 * same way the whole-file reader folds them.
 */
function SplitFile({ diff, text, testId }: { diff: string; text: string; testId: string }) {
  const rows = useMemo(() => buildSplitRows(text, diff), [text, diff])
  const [open, setOpen] = useState<number | undefined>(undefined)
  const body = useMemo(() => collapseSplitRows(rows, 3, 2, open), [rows, open])
  const trailing = body.gaps.get(body.rows.length)
  const gap = (entry: FileGap, key: string) => (
    <button
      key={key}
      type="button"
      className="diorama-diff__gap"
      data-testid="git-diff-gap"
      title={`展开第 ${entry.from}–${entry.to} 行`}
      onClick={() => setOpen(entry.openedBy)}
    >
      <Icon name="unfold" size={13} />
      <span>
        {entry.count} 行未改动（第 {entry.from}–{entry.to} 行）
      </span>
    </button>
  )
  return (
    <div className="diorama-diff__text" data-testid={testId} data-mode="split" role="group" aria-label="新旧文件对照">
      <div className="diorama-diff__split-head" aria-hidden="true">
        <span className="diorama-diff__split-title">旧</span>
        <span className="diorama-diff__split-title">新</span>
      </div>
      {body.rows.map((row, index) => {
        const folded = body.gaps.get(index)
        if (folded !== undefined) return gap(folded, `gap-${index}`)
        return (
          <div key={index} className="diorama-diff__split-row" data-change={row.change || undefined}>
            {([row.old, row.next] as const).map((cell, side) => (
              <div
                key={side}
                className={`diorama-diff__split-cell${cell === undefined ? ' diorama-diff__split-cell--empty' : ` diorama-diff__line--${cell.tone}`}`}
                data-tone={cell?.tone ?? 'empty'}
                data-line={cell?.number}
              >
                <span className="diorama-diff__num" aria-hidden="true">
                  {cell?.number ?? ''}
                </span>
                <span className="diorama-diff__code">{cell === undefined || cell.text === '' ? '\u00a0' : cell.text}</span>
              </div>
            ))}
          </div>
        )
      })}
      {trailing !== undefined && gap(trailing, 'gap-tail')}
    </div>
  )
}

/** One mode button: the label is the icon, the tooltip says what it does. */
const MODE_BUTTONS: readonly { mode: DiffMode; icon: string; label: string; title: string }[] = [
  { mode: 'inline', icon: 'diff', label: '改动', title: '只看改动（与 git diff 一致）' },
  { mode: 'file', icon: 'file-text', label: '整个文件', title: '把改动放进整个文件里看（单栏）' },
  { mode: 'split', icon: 'columns', label: '新旧对照', title: '左旧右新，两栏对照（双栏）' },
]

/** The three buttons that pick how a diff is read. */
function ModeSwitch({ mode, ids }: { mode: DiffMode; ids: DiffTestIds }) {
  const testIds: Record<DiffMode, string> = { inline: ids.modeInline, file: ids.modeFile, split: ids.modeSplit }
  return (
    <span className="diorama-diff__modes" role="group" aria-label="显示方式">
      {MODE_BUTTONS.map(button => (
        <button
          key={button.mode}
          type="button"
          aria-pressed={mode === button.mode}
          aria-label={button.label}
          title={button.title}
          data-testid={testIds[button.mode]}
          onClick={() => setDiffMode(button.mode)}
        >
          <Icon name={button.icon} size={14} />
        </button>
      ))}
    </span>
  )
}

/**
 * The history: recent commits in the left column (contract.md §5.2, v0.6).
 * Picking one shows it in the right column (`seats.git-commit`) and records it
 * in the hash (`#history=<sha>`), so a refresh comes back to the same commit.
 * Commits are paged by `log()`'s limit; "more" asks for the next page.
 */
const HISTORY_PAGE = 50

/** One repository's commits in the history view (v0.10). */
interface HistoryGroup {
  repo: string
  commits: GitLogEntry[]
}

/**
 * The history of **every** repository of the mount (v0.10), grouped: a mount
 * may hold several, and each has its own first commit. The limit is per
 * repository, the same way the changes view's list is per repository.
 */
function useHistory(git: GitClient): {
  groups: HistoryGroup[] | undefined
  error: string | undefined
  more: boolean
  loadMore(): void
  reload(): void
} {
  const [limit, setLimit] = useState(HISTORY_PAGE)
  const [epoch, setEpoch] = useState(0)
  const [state, setState] = useState<{ groups?: HistoryGroup[]; error?: string }>({})
  useEffect(() => {
    let live = true
    const load = async (): Promise<HistoryGroup[]> => {
      const repos = await git.repos()
      return Promise.all(
        repos.map(async repo => ({ repo: repo.path, commits: await git.log({ limit, repo: repo.path }) })),
      )
    }
    load().then(
      groups => {
        if (live) setState({ groups })
      },
      (error: unknown) => {
        if (live) setState({ error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [git, limit, epoch])
  const groups = state.groups
  return {
    groups,
    error: state.error,
    // A full page may or may not have more; the next ask that comes back short ends it.
    more:
      groups !== undefined &&
      groups.some(group => group.commits.length === limit) &&
      limit < MAX_LOG_LIMIT_PAGE,
    loadMore: () => setLimit(value => Math.min(value + HISTORY_PAGE, MAX_LOG_LIMIT_PAGE)),
    reload: () => setEpoch(value => value + 1),
  }
}

/** The most commits this view asks for at once (the service caps at 500). */
const MAX_LOG_LIMIT_PAGE = 500

/** When a commit was made, in the reader's locale (date + time, minute precision). */
function formatWhen(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function HistoryView({ active }: { active: boolean }) {
  const { mount, ctx } = useKernel()
  const git = mount.git
  const history = useHistory(git)
  const router = ctx.router
  const selected = useHistorySelection(ctx)
  // Repository groups fold like the changes view's (v0.10).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  void active
  if (history.error !== undefined) {
    return (
      <div className="diorama-changes" data-testid="git-history" role="alert">
        {history.error}
      </div>
    )
  }
  if (history.groups === undefined) {
    return (
      <div className="diorama-changes" data-testid="git-history">
        正在读取历史…
      </div>
    )
  }
  const total = history.groups.reduce((sum, group) => sum + group.commits.length, 0)
  if (total === 0) {
    return (
      <div className="diorama-changes diorama-changes__empty" data-testid="git-history" role="status">
        还没有提交
      </div>
    )
  }
  const pick = (repo: string, sha: string): void => {
    // The value carries the commit **and its repository** (v0.10): the same sha
    // is a different commit in another repository. `''` would mean "nothing
    // picked".
    router?.state(HISTORY_HASH_KEY).set(historyHashValue(repo, sha))
  }
  const showHeaders = history.groups.length > 1
  return (
    <div className="diorama-changes" data-testid="git-history">
      <div className="diorama-changes__group">
        <span>
          {total} 个提交
          {showHeaders ? ` · ${history.groups.length} 个仓库` : ''}
        </span>
        <button
          type="button"
          className="diorama-changes__reload"
          data-testid="git-history-reload"
          title="刷新提交历史"
          aria-label="刷新提交历史"
          onClick={history.reload}
        >
          <Icon name="reload" size={14} />
        </button>
      </div>
      {history.groups.map(group => {
        const key = `repo:${group.repo}`
        const closed = collapsed.has(key)
        const label = group.repo === '' ? '(挂载目录)' : group.repo
        return (
          <div className="diorama-changes__repo" key={group.repo} data-repo={group.repo} data-testid="git-history-repo">
            {showHeaders ? (
              <button
                type="button"
                className="diorama-changes__repo-head"
                aria-expanded={!closed}
                title={group.repo === '' ? '仓库根就是挂载目录' : group.repo}
                onClick={() => toggle(key)}
              >
                <span className="diorama-tree__caret" aria-hidden="true">
                  <Icon name={closed ? 'caret-right' : 'caret-down'} size={14} />
                </span>
                <FileIcon name={label} kind="dir" expanded={!closed} />
                <span className="diorama-changes__repo-name">{label}</span>
                <span className="diorama-changes__count">{group.commits.length}</span>
              </button>
            ) : null}
            {closed ? null : (
              <div className="diorama-history" role="listbox" aria-label="提交历史">
                {group.commits.map(commit => {
                  const current = commit.sha === selected?.commit && group.repo === selected.repo
                  return (
                    <button
                      key={`${group.repo}:${commit.sha}`}
                      type="button"
                      role="option"
                      aria-selected={current}
                      className={`diorama-history__row${current ? ' diorama-changes__row--selected' : ''}`}
                      data-sha={commit.sha}
                      data-repo={group.repo}
                      data-testid="git-history-commit"
                      title={`${commit.sha}\n${commit.author} · ${formatWhen(commit.at)}`}
                      onClick={() => pick(group.repo, commit.sha)}
                    >
                      <span className="diorama-history__subject">{commit.subject || '(无提交说明)'}</span>
                      <span className="diorama-history__meta">
                        <code>{commit.shortSha}</code>
                        <span className="diorama-history__author">{commit.author}</span>
                        <time dateTime={new Date(commit.at).toISOString()}>{formatWhen(commit.at)}</time>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {history.more && (
        <button type="button" className="diorama-changes__reload" data-testid="git-history-more" onClick={history.loadMore}>
          <Icon name="caret-down" size={14} />
          加载更多
        </button>
      )}
    </div>
  )
}

/**
 * The commit the history view has picked: the hash value, kept in step with
 * the seat. One writer (this view) and one reader (the seat) share the slot.
 */
function useHistorySelection(ctx: unknown): PickedCommit | undefined {
  const [selected, setSelected] = useState<PickedCommit | undefined>(() => readHistoryHash(ctx))
  useEffect(() => {
    const slot = historySlot(ctx)
    if (slot === undefined) return
    const sync = (): void => {
      setSelected(parseHistoryHash(slot.get()))
    }
    sync()
    return slot.onChange(sync)
  }, [ctx])
  return selected
}

/** Read and write `#history` through the router (absent outside a page). */
function historySlot(ctx: unknown): { get(): string | undefined; set(value: string | undefined): void; onChange(fn: () => void): () => void } | undefined {
  try {
    const router = (ctx as { router?: { state(key: string): { get(): string | undefined; set(value: string | undefined): void; onChange(fn: () => void): () => void } } }).router
    return router?.state(HISTORY_HASH_KEY)
  } catch {
    return undefined
  }
}

function readHistoryHash(ctx: unknown): PickedCommit | undefined {
  return parseHistoryHash(historySlot(ctx)?.get())
}

/**
 * The commit seat (contract.md §5, v0.6): message, author and the files the
 * commit touched. Picking a file shows its change in that commit, with a
 * toggle for the file's content at that commit (`blob()`).
 */
function CommitSeat({ commit, repo }: CommitSeatProps) {
  const { mount } = useKernel()
  const git = mount.git
  const [state, setState] = useState<{ status: string; detail?: CommitDetail; error?: string }>({ status: 'loading' })
  const [picked, setPicked] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    setPicked(undefined)
    // The repository matters (v0.10): the same sha is a different commit in
    // another repository, and the mount's own repository is only the default.
    git.showCommit(commit, repo).then(
      detail => {
        if (!live) return
        setState({ status: 'ready', detail })
        // No pick yet: the first changed file is the natural one to show.
        setPicked(detail.files[0]?.file)
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [git, commit, repo])
  if (state.status === 'loading') {
    return (
      <div className="diorama-diff" data-testid="git-commit-loading">
        正在读取提交…
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="diorama-diff diorama-renderer__error" role="alert" data-testid="git-commit-error">
        {state.error}
      </div>
    )
  }
  const detail = state.detail as CommitDetail
  const file = picked === undefined ? undefined : detail.files.find(item => item.file === picked)
  return (
    <div className="diorama-diff" data-testid="git-commit" data-sha={detail.sha}>
      <div className="diorama-diff__header">
        <code className="diorama-git-commit__sha">{detail.shortSha}</code>
        <CommitMessage detail={detail} />
      </div>
      <div className="diorama-git-commit__meta">
        {detail.author} · {formatWhen(detail.at)}
      </div>
      {detail.truncated === true && (
        <div className="diorama-diff__notes" role="status">
          改动的文件过多，只列出了一部分
        </div>
      )}
      <div className="diorama-git-commit__body">
        <div className="diorama-git-commit__files">
          <div className="diorama-changes__group">
            <span>{detail.files.length} 个文件</span>
          </div>
          {detail.files.map(item => (
            <button
              key={item.file}
              type="button"
              className={`diorama-changes__row${item.file === picked ? ' diorama-changes__row--selected' : ''}`}
              data-file={item.file}
              data-testid="git-commit-file"
              onClick={() => setPicked(item.file)}
            >
              <span className={`diorama-changes__badge diorama-changes__badge--${TONE[item.kind]}`} aria-hidden="true">
                {BADGE[item.kind]}
              </span>
              <span className="diorama-changes__name">{item.file}</span>
            </button>
          ))}
        </div>
        <div className="diorama-git-commit__panel">
          {file === undefined && (
            <div className="diorama-renderer__empty" role="status" data-testid="git-commit-empty">
              这个提交没有改动
            </div>
          )}
          {file !== undefined && <CommitFileDiff commit={detail.sha} file={file} repo={repo} />}
        </div>
      </div>
    </div>
  )
}

/**
 * The commit message: the subject on one line, the rest (git's body, after the
 * first blank line) folded away until asked for. A long message must not push
 * the file list off the screen — the list is what the seat is for.
 */
function CommitMessage({ detail }: { detail: CommitDetail }) {
  const body = messageBody(detail.message)
  const [open, setOpen] = useState(false)
  const title = detail.subject || detail.sha
  if (body === '') {
    return (
      <span className="diorama-diff__path diorama-git-commit__subject" data-testid="git-commit-message">
        {title}
      </span>
    )
  }
  return (
    <div className="diorama-git-commit__message-block">
      <button
        type="button"
        className="diorama-git-commit__subject-toggle"
        aria-expanded={open}
        title={open ? '收起提交说明' : '展开完整提交说明'}
        data-testid="git-commit-message-toggle"
        onClick={() => setOpen(value => !value)}
      >
        <Icon name={open ? 'caret-down' : 'caret-right'} size={14} />
        <span className="diorama-git-commit__subject" data-testid="git-commit-message">
          {title}
        </span>
      </button>
      {open && (
        <pre className="diorama-git-commit__message" data-testid="git-commit-message-body">
          {body}
        </pre>
      )}
    </div>
  )
}

/**
 * The part of a commit message after its subject: everything following a
 * blank line. A message whose lines are all connected has no body — git would
 * call that whole text the subject, and the title line already shows it.
 */
export function messageBody(message: string): string {
  const lines = message.replace(/\n+$/, '').split('\n')
  const blank = lines.findIndex(line => line.trim() === '')
  if (blank === -1) return ''
  return lines
    .slice(blank + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/** The whole file at a commit, read for the "whole file" mode (`blob()`). */
function useCommitText(commit: string, path: string, wanted: boolean, repo?: string): FileState {
  const { mount } = useKernel()
  const [state, setState] = useState<FileState>({ status: 'idle' })
  useEffect(() => {
    if (!wanted) {
      setState({ status: 'idle' })
      return
    }
    let live = true
    setState({ status: 'loading' })
    mount.git.blob(commit, path, repo).then(
      result => {
        if (!live) return
        if (result.binary === true) {
          setState({ status: 'note', note: `二进制文件（${formatBytes(result.size)}），只显示改动` })
          return
        }
        setState({ status: 'ready', text: result.text ?? '' })
      },
      (error: unknown) => {
        if (live) setState({ status: 'note', note: `读取失败：${(error as Error).message}` })
      },
    )
    return () => {
      live = false
    }
  }, [mount, commit, path, wanted, repo])
  return state
}

/**
 * One file's change in the commit (`show()`), read the same two ways as a
 * working-tree diff. The "whole file" mode here is the file **as the commit
 * left it** (`blob()`), so the code around a change is the code that change
 * produced — not today's working tree, which may be nothing like it.
 */
function CommitFileDiff({ commit, file, repo }: { commit: string; file: DiffEntry; repo?: string }) {
  const { mount } = useKernel()
  const [state, setState] = useState<{ status: string; entry?: DiffEntry; error?: string }>({
    status: file.text === undefined && file.binary !== true ? 'loading' : 'ready',
    entry: file,
  })
  const mode = useDiffMode()
  useEffect(() => {
    // `showCommit()` already carries the text; only a text-less entry (a
    // binary, or a file the commit did not change) asks again.
    if (file.text !== undefined || file.binary === true) {
      setState({ status: 'ready', entry: file })
      return
    }
    let live = true
    mount.git.show(commit, file.file, repo).then(
      entry => {
        if (live) setState({ status: 'ready', entry })
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [mount, commit, file, repo])
  // Both content modes need the file (v0.10, m13 §2): "whole file" puts the
  // change inside the file's own line numbers, and "split" needs the unchanged
  // lines for both columns. Asking for it only in `file` mode left `split` with
  // no text at all, so the button did nothing in the commit seat.
  const whole = useCommitText(commit, file.file, mode !== 'inline' && file.binary !== true, repo)
  if (state.status === 'loading') {
    return <div className="diorama-renderer" data-testid="git-commit-diff-loading">正在读取改动…</div>
  }
  if (state.status === 'error') {
    return (
      <div className="diorama-renderer__error" role="alert" data-testid="git-commit-diff-error">
        {state.error}
      </div>
    )
  }
  const entry = state.entry as DiffEntry
  return (
    <DiffView
      path={file.file}
      kind={entry.kind}
      oldPath={entry.oldPath}
      diff={entry.text ?? ''}
      binary={entry.binary === true}
      error={undefined}
      truncated={entry.truncated === true}
      callTruncated={false}
      notes={[]}
      loading={false}
      whole={whole}
      testIds={{
        root: 'git-commit-diff',
        text: 'git-commit-diff-text',
        notes: 'git-commit-diff-notes',
        empty: 'git-commit-diff-empty',
        error: 'git-commit-diff-error',
        loading: 'git-commit-diff-loading',
        modeInline: 'git-commit-mode-diff',
        modeFile: 'git-commit-mode-content',
        modeSplit: 'git-commit-mode-split',
      }}
    />
  )
}

/** The `git` client half. */
export function apply(ctx: Context) {
  // Client-only: the same module is also loaded as this piece's server half,
  // where neither the mount nor `ctx.slots` exists (docs/m2/spec.md §6.2 rule 3).
  const mount = clientMount(ctx)
  if (mount === undefined) return
  // The seat a diff tab draws its file in (contract.md §3.4): a single seat the
  // tabs piece looks up only for `view: 'diff'` tabs, so this piece never takes
  // a `file.renderer` slot away from the content renderers.
  provideEntry(ctx, { id: 'git-changes:diff', name: 'seats.git-diff', order: 100 }, TabDiff)
  // Refresh with `#diff=<path>` in the URL: bring the diff tab back (the
  // router has the value before any piece activates). The key is ours; no
  // other piece reads `diff` (contract.md §3.8).
  restoreDiff(ctx)
  // `#diff` means "the diff being looked at", so it goes away when that is no
  // longer true: the active tab is not that diff (the user switched to the
  // content tab, opened another file from the tree) or the diff tab is gone.
  trackDiffHash(ctx)
  // The commit seat is declared by `tabs`, like the diff seat (contract.md §5,
  // v0.6); this piece fills it. A commit is shown without being a tab.
  provideEntry(ctx, { id: 'git-changes:commit', name: 'seats.git-commit', order: 100 }, CommitSeat)
  // Both views exist only where there is a repository (contract.md §3.2).
  void hasGit(mount.git).then(present => {
    if (!present) return
    provideEntry(
      ctx,
      { id: 'git-changes:view', name: 'sidebar.views', key: CHANGES_VIEW, order: 20, title: '变更', icon: CHANGES_ICON },
      ChangesView,
    )
    provideEntry(
      ctx,
      { id: 'git-changes:history', name: 'sidebar.views', key: HISTORY_VIEW, order: 30, title: '历史', icon: HISTORY_ICON },
      HistoryView,
    )
  })
}

/**
 * Keep `#diff` in step with what is being looked at. The router writes the
 * hash only when a piece asks it to, and only the piece knows when "a diff is
 * open" stopped being true; this is that watcher (one subscription to `tabs`,
 * torn down with the page).
 */
function trackDiffHash(ctx: Context): void {
  let router: { state(key: string): { get(): string | undefined; set(value: string | undefined): void } } | undefined
  try {
    router = (ctx as unknown as { router?: typeof router }).router
  } catch {
    return
  }
  if (router === undefined) return
  const slot = router.state(DIFF_HASH_KEY)
  let seen: TabsService | undefined
  let attempts = 0
  const sync = (): void => {
    const tabs = clientTabs(ctx)
    if (tabs === undefined) {
      // Boot order: `tabs` may activate after this piece (a few frames).
      if (++attempts > 120) return
      requestFrame(sync)
      return
    }
    if (seen !== tabs) {
      seen = tabs
      tabs.subscribe(sync)
    }
    // Both directions: the flag is in the URL exactly while the active tab is
    // a diff. Hiding it on a content tab and putting it back when the user
    // returns to the diff tab is the same rule (one writer, one state).
    const isDiff = tabs.active?.view === 'diff'
    const has = slot.get() !== undefined
    if (isDiff && !has) slot.set('')
    else if (!isDiff && has) slot.set(undefined)
  }
  sync()
}

/**
 * Open the diff tab a refresh asked for. The value is already in the router
 * (it decodes the hash before any piece activates); `tabs` may activate after
 * this piece, so the open is retried until the service answers — a handful of
 * frames, never a polling loop.
 */
function restoreDiff(ctx: Context): void {
  let router: { state(key: string): { get(): string | undefined } } | undefined
  try {
    router = (ctx as unknown as { router?: typeof router }).router
  } catch {
    return
  }
  if (router === undefined) return
  if (router.state(DIFF_HASH_KEY).get() === undefined) return
  const path = routerFile(ctx)
  if (path === undefined) return
  let attempts = 0
  const tryOpen = (): void => {
    const tabs = clientTabs(ctx)
    if (tabs !== undefined) {
      tabs.open(diffFile(path), { view: 'diff' })
      return
    }
    if (++attempts > 120) return // ~2s at a frame per try; the piece is not in this page
    requestFrame(tryOpen)
  }
  tryOpen()
}

/** The file the URL names (the path half), read from the router. */
function routerFile(ctx: Context): string | undefined {
  try {
    const router = (ctx as unknown as { router?: { current?(): string | undefined } }).router
    return router?.current?.()
  } catch {
    return undefined
  }
}

/** Retry on the next frame (or a timer where there is no `requestAnimationFrame`). */
function requestFrame(callback: () => void): void {
  const scope = globalThis as { setTimeout?: typeof setTimeout; requestAnimationFrame?: (cb: () => void) => number }
  if (typeof scope.requestAnimationFrame === 'function') scope.requestAnimationFrame(callback)
  else scope.setTimeout?.(callback, 16)
}

/**
 * `ctx.tabs` when the page has it (the server half has no tabs).
 *
 * Read through the page bridge: each half is its own build, and a service the
 * `tabs` half provided is not visible on this half's own Cordis context. The
 * bridge's kernel context is the page's, where every piece's services land.
 */
function clientTabs(ctx: Context): TabsService | undefined {
  try {
    const page = (globalThis as unknown as { __diorama_page__?: { getKernel?(): { ctx?: { tabs?: TabsService } } } })
      .__diorama_page__
    const fromBridge = page?.getKernel?.()?.ctx?.tabs
    if (fromBridge !== undefined) return fromBridge
  } catch {
    // Not a page (the server tree): fall through to the local context.
  }
  try {
    return (ctx as unknown as { tabs?: TabsService }).tabs
  } catch {
    return undefined
  }
}

/** The mount handle when this context is a page, else `undefined`. */
function clientMount(ctx: Context): { git: GitClient } | undefined {
  try {
    return (ctx as unknown as { mount?: { git: GitClient } }).mount
  } catch {
    return undefined
  }
}

/** Unused re-export guard: the element type is imported for its props shape. */
export type { ReactElement }
