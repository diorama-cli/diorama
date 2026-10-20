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
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { ChangeTreeNode, CommitDetail, DiffEntry, DiffResult, FileInfo, GitLogEntry, GitStatusEntry } from 'diorama-kernel'
import { buildChangeTree, hasGit, type GitClient, type TabsService } from 'diorama-kernel/client'
import { provideEntry, useKernel } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'
import type { CommitSeatProps, TabDiffProps } from 'diorama-plugin-slots'

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
 */
export const HISTORY_HASH_KEY = 'history'

/** The switcher icon (inline SVG; `layout` draws it verbatim). */
export const CHANGES_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="3.5" r="1.6"/><circle cx="5" cy="12.5" r="1.6"/><circle cx="11" cy="5.5" r="1.6"/><path d="M5 5.1v5.8M11 7.1c0 2-1.5 2.6-3.2 3.4"/></svg>'

/** The history view's icon (a commit graph). */
export const HISTORY_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 2v12"/><circle cx="3" cy="5" r="1.7"/><circle cx="3" cy="11" r="1.7"/><path d="M4.7 5h2.3a3 3 0 0 1 3 3v2"/><circle cx="13" cy="11" r="1.7"/></svg>'

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

/** The changes view (contract.md §5.2). */
function ChangesView({ active }: { active: boolean }) {
  const { mount, ctx } = useKernel()
  const tabs = ctx.tabs as TabsService | undefined
  const changes = useChanges(mount)
  const activeTab = useTabPath(tabs)
  const router = ctx.router
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
  return (
    <div className="diorama-changes" data-testid="git-changes">
      <div className="diorama-changes__group">
        <span>{changes.entries.length} 个改动</span>
        <button type="button" className="diorama-changes__reload" data-testid="git-changes-reload" onClick={changes.reload}>
          刷新
        </button>
      </div>
      <ChangeTree entries={changes.entries} selected={activeTab} onOpen={open} />
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
          {closed ? '▸' : '▾'}
        </span>
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

/** Colour a unified diff line (`+`, `-`, `@@`, file headers). */
function lineTone(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity') ||
    line.startsWith('rename ')
  ) {
    return 'meta'
  }
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
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

/** Bytes of an untracked file shown in full (above this, say how big it is). */
export const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

/** Lines of an untracked file shown in full. */
export const MAX_UNTRACKED_LINES = 5000

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`
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
  const entry = state.result.entries.find(item => item.file === tab.path)
  return (
    <DiffBody
      path={tab.path}
      entry={entry}
      truncated={state.result.truncated}
      added={added}
      onRefresh={() => setEpoch(value => value + 1)}
    />
  )
}

/** The diff itself: a header, the unified text split into lines, and the flags. */
function DiffBody({
  path,
  entry,
  truncated,
  added,
  onRefresh,
}: {
  path: string
  entry: DiffResult['entries'][number] | undefined
  truncated: boolean
  /** The whole content of a file that has no diff (untracked). */
  added: AddedState
  onRefresh(): void
}) {
  if (entry === undefined) {
    return (
      <div className="diorama-diff" data-testid="git-diff">
        <div className="diorama-diff__header">{path}</div>
        <div className="diorama-renderer__empty" role="status" data-testid="git-diff-empty">
          这个文件没有未提交的改动
        </div>
      </div>
    )
  }
  if ('error' in entry) {
    return (
      <div className="diorama-diff" data-testid="git-diff">
        <div className="diorama-diff__header">{path}</div>
        <div className="diorama-renderer__error" role="alert" data-testid="git-diff-error">
          {entry.error.code}: {entry.error.message}
        </div>
      </div>
    )
  }
  const notes: string[] = []
  if (entry.binary === true) notes.push('二进制文件：git 不提供文本 diff')
  if (entry.truncated === true) notes.push('这个文件的 diff 过大，已截断')
  if (truncated) notes.push('改动过多，只显示了一部分')
  if (entry.oldPath !== undefined) notes.push(`由 ${entry.oldPath} 改名`)
  // A file with no diff text gets its whole content as an addition (below);
  // the diff text itself is used when git produced one.
  const whole = entry.text === undefined && added.status === 'ready' ? added : undefined
  const lines = whole === undefined
    ? (entry.text ?? '').split('\n')
    : whole.lines.map(line => `+${line}`)
  if (whole === undefined && lines[lines.length - 1] === '') lines.pop()
  if (whole !== undefined) {
    notes.push(...whole.notes)
    if (whole.truncated) notes.push('已截断')
  }
  return (
    <div className="diorama-diff" data-testid="git-diff" data-kind={entry.kind}>
      <div className="diorama-diff__header">
        <span className={`diorama-changes__badge diorama-changes__badge--${TONE[entry.kind]}`} aria-hidden="true">
          {BADGE[entry.kind]}
        </span>
        <span className="diorama-diff__path">{path}</span>
        <button type="button" className="diorama-diff__reload" onClick={onRefresh}>
          重新读取
        </button>
      </div>
      {notes.length > 0 && (
        <div className="diorama-diff__notes" role="status" data-testid="git-diff-notes">
          {notes.join('；')}
        </div>
      )}
      {lines.length === 0 && entry.text === undefined && added.status === 'loading' && (
        <div className="diorama-renderer" data-testid="git-diff-loading">
          正在读取文件…
        </div>
      )}
      {lines.length > 0 && <DiffLines lines={lines} />}
    </div>
  )
}

/**
 * Unified diff lines, coloured (contract.md §3.2: the text, not a parsed
 * model). Shared by the working-tree diff and a commit's file list.
 */
function DiffLines({ lines, testId = 'git-diff-text' }: { lines: readonly string[]; testId?: string }) {
  return (
    <pre className="diorama-diff__text" data-testid={testId}>
      {lines.map((line, index) => (
        <div key={index} className={`diorama-diff__line diorama-diff__line--${lineTone(line)}`}>
          {line === '' ? '\u00a0' : line}
        </div>
      ))}
    </pre>
  )
}

/** The lines of a unified diff, without the trailing newline artifact. */
function diffLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The history: recent commits in the left column (contract.md §5.2, v0.6).
 * Picking one shows it in the right column (`seats.git-commit`) and records it
 * in the hash (`#history=<sha>`), so a refresh comes back to the same commit.
 * Commits are paged by `log()`'s limit; "more" asks for the next page.
 */
const HISTORY_PAGE = 50

function useHistory(git: GitClient): {
  commits: GitLogEntry[] | undefined
  error: string | undefined
  more: boolean
  loadMore(): void
  reload(): void
} {
  const [limit, setLimit] = useState(HISTORY_PAGE)
  const [epoch, setEpoch] = useState(0)
  const [state, setState] = useState<{ commits?: GitLogEntry[]; error?: string }>({})
  useEffect(() => {
    let live = true
    git.log({ limit }).then(
      commits => {
        if (live) setState({ commits })
      },
      (error: unknown) => {
        if (live) setState({ error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [git, limit, epoch])
  const commits = state.commits
  return {
    commits,
    error: state.error,
    // A full page may or may not have more; the next ask that comes back short ends it.
    more: commits !== undefined && commits.length === limit && limit < MAX_LOG_LIMIT_PAGE,
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
  void active
  if (history.error !== undefined) {
    return (
      <div className="diorama-changes" data-testid="git-history" role="alert">
        {history.error}
      </div>
    )
  }
  if (history.commits === undefined) {
    return (
      <div className="diorama-changes" data-testid="git-history">
        正在读取历史…
      </div>
    )
  }
  if (history.commits.length === 0) {
    return (
      <div className="diorama-changes diorama-changes__empty" data-testid="git-history" role="status">
        还没有提交
      </div>
    )
  }
  const pick = (sha: string): void => {
    // The value carries the commit; `''` would mean "nothing picked".
    router?.state(HISTORY_HASH_KEY).set(sha)
  }
  return (
    <div className="diorama-changes" data-testid="git-history">
      <div className="diorama-changes__group">
        <span>{history.commits.length} 个提交</span>
        <button type="button" className="diorama-changes__reload" data-testid="git-history-reload" onClick={history.reload}>
          刷新
        </button>
      </div>
      <div className="diorama-history" role="listbox" aria-label="提交历史">
        {history.commits.map(commit => {
          const current = commit.sha === selected
          return (
            <button
              key={commit.sha}
              type="button"
              role="option"
              aria-selected={current}
              className={`diorama-history__row${current ? ' diorama-changes__row--selected' : ''}`}
              data-sha={commit.sha}
              data-testid="git-history-commit"
              title={`${commit.sha}\n${commit.author} · ${formatWhen(commit.at)}`}
              onClick={() => pick(commit.sha)}
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
      {history.more && (
        <button type="button" className="diorama-changes__reload" data-testid="git-history-more" onClick={history.loadMore}>
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
function useHistorySelection(ctx: unknown): string | undefined {
  const [selected, setSelected] = useState<string | undefined>(() => readHistoryHash(ctx))
  useEffect(() => {
    const slot = historySlot(ctx)
    if (slot === undefined) return
    const sync = (): void => {
      const value = slot.get()
      setSelected(value === undefined || value === '' ? undefined : value)
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

function readHistoryHash(ctx: unknown): string | undefined {
  const value = historySlot(ctx)?.get()
  return value === undefined || value === '' ? undefined : value
}

/**
 * The commit seat (contract.md §5, v0.6): message, author and the files the
 * commit touched. Picking a file shows its change in that commit, with a
 * toggle for the file's content at that commit (`blob()`).
 */
function CommitSeat({ commit }: CommitSeatProps) {
  const { mount } = useKernel()
  const git = mount.git
  const [state, setState] = useState<{ status: string; detail?: CommitDetail; error?: string }>({ status: 'loading' })
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<'diff' | 'content'>('diff')
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    setPicked(undefined)
    git.showCommit(commit).then(
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
  }, [git, commit])
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
          {file !== undefined && (
            <div className="diorama-git-commit__modes" role="group" aria-label="显示方式">
              <button type="button" aria-pressed={mode === 'diff'} data-testid="git-commit-mode-diff" onClick={() => setMode('diff')}>
                改动
              </button>
              <button type="button" aria-pressed={mode === 'content'} data-testid="git-commit-mode-content" onClick={() => setMode('content')}>
                提交时的内容
              </button>
            </div>
          )}
          {file === undefined && (
            <div className="diorama-renderer__empty" role="status" data-testid="git-commit-empty">
              这个提交没有改动
            </div>
          )}
          {file !== undefined && mode === 'diff' && <CommitFileDiff commit={detail.sha} file={file} />}
          {file !== undefined && mode === 'content' && <CommitFileContent commit={detail.sha} path={file.file} />}
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
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
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

/** One file's change in the commit (`show()`), as diff lines. */
function CommitFileDiff({ commit, file }: { commit: string; file: DiffEntry }) {
  const { mount } = useKernel()
  const [state, setState] = useState<{ status: string; entry?: DiffEntry; error?: string }>({
    status: file.text === undefined && file.binary !== true ? 'loading' : 'ready',
    entry: file,
  })
  useEffect(() => {
    // `showCommit()` already carries the text; only a text-less entry (a
    // binary, or a file the commit did not change) asks again.
    if (file.text !== undefined || file.binary === true) {
      setState({ status: 'ready', entry: file })
      return
    }
    let live = true
    mount.git.show(commit, file.file).then(
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
  }, [mount, commit, file])
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
  if (entry.binary === true) {
    return (
      <div className="diorama-renderer__empty" role="status" data-testid="git-commit-diff-binary">
        二进制文件：git 不提供文本 diff
      </div>
    )
  }
  return (
    <div data-testid="git-commit-diff" data-kind={entry.kind}>
      {entry.truncated === true && (
        <div className="diorama-diff__notes" role="status">
          这个文件的 diff 过大，已截断
        </div>
      )}
      <DiffLines lines={diffLines(entry.text ?? '')} testId="git-commit-diff-text" />
    </div>
  )
}

/** One file's content at the commit (`blob()`). */
function CommitFileContent({ commit, path }: { commit: string; path: string }) {
  const { mount } = useKernel()
  const [state, setState] = useState<{ status: string; text?: string; binary?: boolean; size?: number; truncated?: boolean; error?: string }>({
    status: 'loading',
  })
  useEffect(() => {
    let live = true
    mount.git.blob(commit, path).then(
      result => {
        if (live) setState({ status: 'ready', text: result.text, binary: result.binary === true, size: result.size, truncated: result.truncated === true })
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [mount, commit, path])
  if (state.status === 'loading') {
    return <div className="diorama-renderer" data-testid="git-commit-blob-loading">正在读取文件…</div>
  }
  if (state.status === 'error') {
    return (
      <div className="diorama-renderer__error" role="alert" data-testid="git-commit-blob-error">
        {state.error}
      </div>
    )
  }
  if (state.binary === true) {
    return (
      <div className="diorama-renderer__empty" role="status" data-testid="git-commit-blob-binary">
        二进制文件（{formatBytes(state.size ?? 0)}）
      </div>
    )
  }
  return (
    <div data-testid="git-commit-blob">
      {state.truncated === true && (
        <div className="diorama-diff__notes" role="status">
          文件过大（{formatBytes(state.size ?? 0)}），已截断
        </div>
      )}
      <pre className="diorama-diff__text" data-testid="git-commit-blob-text">
        {(state.text ?? '').replace(/\n$/, '')}
      </pre>
    </div>
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
