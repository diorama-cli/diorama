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
import type { DiffResult, FileInfo, GitStatusEntry } from 'diorama-kernel'
import { hasGit, type GitClient, type TabsService } from 'diorama-kernel/client'
import { provideEntry, useKernel } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'
import type { TabDiffProps } from 'diorama-plugin-slots'

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

/** The switcher icon (inline SVG; `layout` draws it verbatim). */
export const CHANGES_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="3.5" r="1.6"/><circle cx="5" cy="12.5" r="1.6"/><circle cx="11" cy="5.5" r="1.6"/><path d="M5 5.1v5.8M11 7.1c0 2-1.5 2.6-3.2 3.4"/></svg>'

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

/** Changed files of the working tree: fetched on mount, refreshed on demand. */
function useChanges(git: GitClient): {
  entries: GitStatusEntry[] | undefined
  error: string | undefined
  reload(): void
} {
  const [state, setState] = useState<{ entries?: GitStatusEntry[]; error?: string }>({})
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    let live = true
    git.status().then(
      entries => {
        if (live) setState({ entries })
      },
      (error: unknown) => {
        if (live) setState({ error: error instanceof Error ? error.message : String(error) })
      },
    )
    // `ctx.git` has no subscription endpoint (contract.md §3.2): a slow poll is
    // enough for a read-only list, and expands on demand like the file tree.
    const timer = setInterval(() => {
      git.status().then(entries => {
        if (live) setState({ entries })
      }, () => {})
    }, 5_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [git, epoch])
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
  onOpen,
}: {
  entry: GitStatusEntry
  selected: boolean
  onOpen(entry: GitStatusEntry): void
}) {
  const name = entry.file.slice(entry.file.lastIndexOf('/') + 1)
  const directory = entry.file.slice(0, Math.max(0, entry.file.lastIndexOf('/')))
  return (
    <button
      type="button"
      className={`diorama-changes__row${selected ? ' diorama-changes__row--selected' : ''}`}
      data-path={entry.file}
      data-kind={entry.kind}
      title={entry.oldPath === undefined ? entry.file : `${entry.oldPath} → ${entry.file}`}
      onClick={() => onOpen(entry)}
    >
      <span className={`diorama-changes__badge diorama-changes__badge--${TONE[entry.kind]}`} aria-hidden="true">
        {BADGE[entry.kind]}
      </span>
      <span className="diorama-changes__name">{name}</span>
      {directory === '' ? null : <span className="diorama-changes__dir">{directory}</span>}
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
  const git = mount.git
  const tabs = ctx.tabs as TabsService | undefined
  const changes = useChanges(git)
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
      {changes.entries.map(entry => (
        <ChangeRow key={`${entry.file}:${entry.status}`} entry={entry} selected={entry.file === activeTab} onOpen={open} />
      ))}
    </div>
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
      {lines.length > 0 && (
        <pre className="diorama-diff__text" data-testid="git-diff-text">
          {lines.map((line, index) => (
            <div key={index} className={`diorama-diff__line diorama-diff__line--${lineTone(line)}`}>
              {line === '' ? '\u00a0' : line}
            </div>
          ))}
        </pre>
      )}
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
  // The changes view exists only where there is a repository (contract.md §3.2).
  void hasGit(mount.git).then(present => {
    if (!present) return
    provideEntry(
      ctx,
      { id: 'git-changes:view', name: 'sidebar.views', key: CHANGES_VIEW, order: 20, title: '变更', icon: CHANGES_ICON },
      ChangesView,
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
