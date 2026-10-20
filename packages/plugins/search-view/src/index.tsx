/**
 * search-view — file search over the mounted directory (contract.md §3.9).
 *
 * The *service* is the kernel's `ctx.search` (id `search`, provided per mount,
 * `--plugins` cannot remove it); this piece is its only UI. The two ids differ
 * on purpose: one id cannot be both a kernel service and a client piece (the
 * CLI's server-half map would hold one key twice — the same split as
 * `git` / `git-changes`).
 *
 * One piece, two surfaces, the way VS Code splits them:
 *
 * - `sidebar.views` / `key = 'search'`: the **search view** — a field, two
 *   modes (by name / by content) and the results as a collapsible list. Picking
 *   a hit opens the file in a tab and sends the reader to the line.
 * - `layout.overlay`: **quick open** — `mod+p`, a field and the files whose
 *   paths match, for jumping to a file without the tree.
 *
 * Both read `mountCtx.search` (`ctx.search`, contract.md §3.9): the walking and
 * reading happen on the server, behind the mount's own `ignore` rules. This
 * piece only debounces, ranks and draws.
 *
 * Opening a hit uses `ctx.tabs` like every other opener (contract.md §3.4), and
 * the line travels through `diorama-ui`'s reveal store — a tab carries a path
 * only, so the line cannot live in it.
 */
import type { Context } from 'cordis'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FileInfo, MountHandle } from 'diorama-kernel/client'
import type { SearchOptions, SearchResult } from 'diorama-kernel/client'
import type { TabsService } from 'diorama-kernel/client'
import { fuzzyMatch } from 'diorama-kernel/client'
import { closeOverlay, FileIcon, hideOverlay, Icon, iconSvg, overlayStore, provideEntry, reveal, toggleOverlay, useKernel } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'
import { flattenResult, highlightPositions, highlightRange, splitPath, summarize, type ResultRow } from './results.ts'

export const name = 'search-view'
export const inject = ['slots']

/** The sidebar view's key (contract.md §5.2). */
export const SEARCH_VIEW = 'search'

/** This overlay's id in the page's overlay store (see `diorama-ui/overlay`). */
export const QUICK_OPEN_ID = 'quick-open'

/** The switcher icon (docs/m7/spec.md §3: the page's button table). */
export const SEARCH_ICON = iconSvg('search')

/** Wait this long after the last keystroke before searching (ms). */
export const DEBOUNCE_MS = 180

/** Rows the quick-open list shows at most. */
export const QUICK_OPEN_LIMIT = 50

/** A file opened by search: the tab only needs a path (contract.md §3.4). */
function fileOf(path: string): FileInfo {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 0, mtime: 0 }
}

/**
 * Run one search when `query` settles. Cancellation is by sequence number: a
 * slower earlier answer never overwrites a newer one.
 */
function useSearch(mount: MountHandle, query: string, options: SearchOptions): {
  result: SearchResult | undefined
  error: string | undefined
  loading: boolean
} {
  const [state, setState] = useState<{ result?: SearchResult; error?: string; loading: boolean }>({ loading: false })
  const seq = useRef(0)
  const key = JSON.stringify(options)
  useEffect(() => {
    if (query === '') {
      setState({ loading: false })
      return
    }
    const id = ++seq.current
    setState(current => ({ ...current, loading: true }))
    const timer = setTimeout(() => {
      mount.search.search(query, options).then(
        result => {
          if (seq.current === id) setState({ result, loading: false })
        },
        (error: unknown) => {
          if (seq.current !== id) return
          setState({ error: error instanceof Error ? error.message : String(error), loading: false })
        },
      )
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `key` stands in for `options`: a fresh object every render must not re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mount, query, key])
  return { result: state.result, error: state.error, loading: state.loading }
}

/** The page's tab service (provided by the `tabs` piece; absent is tolerated). */
function tabsOf(ctx: Context): TabsService | undefined {
  try {
    return (ctx as unknown as { tabs?: TabsService }).tabs
  } catch {
    return undefined
  }
}

/** Open a file at a line: the tab first, the reveal second (the renderer is not mounted yet). */
function openAt(tabs: TabsService | undefined, path: string, line?: number, column?: number, length?: number): void {
  if (tabs === undefined) return
  tabs.open(fileOf(path))
  if (line !== undefined) reveal(path, line, column, length)
}

function Segments({ segments }: { segments: ReturnType<typeof highlightRange> }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="diorama-search__hit">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  )
}

/** One row of the results list. */
function ResultRowView({ row, onPick }: { row: ResultRow; onPick(row: ResultRow): void }) {
  const { dir, name } = splitPath(row.path)
  if (row.kind === 'file') {
    return (
      <button
        type="button"
        className="diorama-search__file"
        data-testid="search-file"
        data-path={row.path}
        title={row.path}
        onClick={() => onPick(row)}
      >
        <FileIcon name={name} />
        <span className="diorama-search__name">{name}</span>
        {dir === '' ? null : <span className="diorama-search__dir">{dir}</span>}
        <span className="diorama-search__count">{row.count}</span>
      </button>
    )
  }
  const match = row.match
  return (
    <button
      type="button"
      className="diorama-search__match"
      data-testid="search-match"
      data-path={row.path}
      data-line={match?.line}
      onClick={() => onPick(row)}
    >
      <span className="diorama-search__line">{match?.line}</span>
      <span className="diorama-search__text">
        <Segments segments={highlightRange(match?.text ?? '', match?.column, match?.length)} />
      </span>
    </button>
  )
}

/** The search view (contract.md §5.2): field, options, results. */
function SearchView({ active }: { active: boolean }) {
  const { mount, ctx } = useKernel()
  const tabs = tabsOf(ctx)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'name' | 'content'>('content')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const field = useRef<HTMLInputElement | null>(null)
  const options = useMemo<SearchOptions>(
    () => ({ kind, caseSensitive, wholeWord, regex: kind === 'content' && regex }),
    [kind, caseSensitive, wholeWord, regex],
  )
  const { result, error, loading } = useSearch(mount, query, options)
  const rows = useMemo(() => flattenResult(result, collapsed), [result, collapsed])
  const summary = summarize(result)

  const pick = (row: ResultRow): void => {
    const match = row.match
    openAt(tabs, row.path, match?.line, match?.column, match?.length)
  }

  // Focusing the field when the view becomes active is what makes `mod+alt+4`
  // useful: the reader types at once (the same rule as the palette).
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => field.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [active])

  const toggle = (path: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="diorama-search" data-testid="search" aria-hidden={active ? undefined : true}>
      <div className="diorama-search__field">
        <input
          ref={field}
          type="search"
          className="diorama-search__input"
          data-testid="search-input"
          placeholder={kind === 'content' ? '在文件中查找…' : '按文件名查找…'}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && rows.length > 0) {
              event.preventDefault()
              const first = rows[0]
              if (first !== undefined) pick(first)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setQuery('')
            }
          }}
        />
        <div className="diorama-search__toggles">
          <button
            type="button"
            aria-pressed={kind === 'content'}
            className={`diorama-search__toggle${kind === 'content' ? ' diorama-search__toggle--on' : ''}`}
            data-testid="search-kind-content"
            title="在文件内容中查找"
            aria-label="在文件内容中查找"
            onClick={() => setKind('content')}
          >
            <Icon name="file-text" size={14} />
          </button>
          <button
            type="button"
            aria-pressed={kind === 'name'}
            className={`diorama-search__toggle${kind === 'name' ? ' diorama-search__toggle--on' : ''}`}
            data-testid="search-kind-name"
            title="按文件名查找"
            aria-label="按文件名查找"
            onClick={() => setKind('name')}
          >
            <Icon name="files" size={14} />
          </button>
          <span className="diorama-search__spacer" />
          <button
            type="button"
            aria-pressed={caseSensitive}
            className={`diorama-search__toggle${caseSensitive ? ' diorama-search__toggle--on' : ''}`}
            data-testid="search-case"
            title="区分大小写"
            aria-label="区分大小写"
            onClick={() => setCaseSensitive(value => !value)}
          >
            <Icon name="text-case" size={14} />
          </button>
          {kind === 'content' ? (
            <>
              <button
                type="button"
                aria-pressed={wholeWord}
                className={`diorama-search__toggle${wholeWord ? ' diorama-search__toggle--on' : ''}`}
                data-testid="search-word"
                title="全字匹配"
                aria-label="全字匹配"
                onClick={() => setWholeWord(value => !value)}
              >
                <Icon name="whole-word" size={14} />
              </button>
              <button
                type="button"
                aria-pressed={regex}
                className={`diorama-search__toggle${regex ? ' diorama-search__toggle--on' : ''}`}
                data-testid="search-regex"
                title="使用正则表达式"
                aria-label="使用正则表达式"
                onClick={() => setRegex(value => !value)}
              >
                <Icon name="regex" size={14} />
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="diorama-search__status" data-testid="search-status" role="status">
        {error !== undefined ? error : loading ? '正在搜索…' : summary}
      </div>
      {result !== undefined && result.files.length > 0 ? (
        <div className="diorama-search__results" data-testid="search-results">
          {rows.map((row, index) =>
            row.kind === 'file' && result.kind === 'content' ? (
              <div key={`f:${row.path}`} className="diorama-search__group">
                <button
                  type="button"
                  className="diorama-search__group-toggle"
                  aria-expanded={!collapsed.has(row.path)}
                  data-testid="search-group"
                  data-path={row.path}
                  onClick={() => toggle(row.path)}
                >
                  <Icon name={collapsed.has(row.path) ? 'caret-right' : 'caret-down'} size={14} />
                </button>
                <ResultRowView row={row} onPick={pick} />
              </div>
            ) : (
              <div key={`${row.kind}:${row.path}:${row.match?.line ?? ''}:${index}`} className="diorama-search__row">
                <ResultRowView row={row} onPick={pick} />
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Whether the quick-open overlay is the one that is up (a primitive snapshot). */
function useQuickOpen(): boolean {
  return useSyncExternalStore(overlayStore.subscribe, overlayStore.getSnapshot, overlayStore.getSnapshot) === QUICK_OPEN_ID
}

/**
 * Quick open (`mod+p`): every path of the mount, ranked by the same fuzzy score
 * the server's name search uses, refreshed once per opening.
 *
 * It lists names only — a content hit needs a line, and this surface has no
 * room to show one; the search view is the place for that.
 */
function QuickOpen() {
  const { mount, ctx } = useKernel()
  const tabs = tabsOf(ctx)
  const open = useQuickOpen()
  const [query, setQuery] = useState('')
  const [paths, setPaths] = useState<readonly string[] | undefined>(undefined)
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    setPaths(undefined)
    const timer = setTimeout(() => input.current?.focus(), 0)
    let live = true
    // One listing per opening, not per key: quick open needs *every* path, and
    // `ctx.search` only answers for a query (an empty one returns nothing —
    // a search is never a directory listing, contract.md §3.9). So the paths
    // come from `fs.list`, and the ranking runs here on every keystroke.
    listFiles(mount).then(
      paths => {
        if (live) setPaths(paths)
      },
      () => {
        if (live) setPaths([])
      },
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, mount])

  const rows = useMemo(() => {
    if (paths === undefined) return []
    const scored: { path: string; score: number; positions: number[] }[] = []
    for (const path of paths) {
      const match = query === '' ? { positions: [] as number[], score: 0 } : fuzzyMatch(path, query)
      if (match === undefined) continue
      scored.push({ path, score: match.score, positions: match.positions })
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    return scored.slice(0, QUICK_OPEN_LIMIT)
  }, [paths, query])

  if (!open) return null
  const active = Math.min(selected, Math.max(rows.length - 1, 0))
  const run = (path: string): void => {
    hideOverlay(QUICK_OPEN_ID)
    openAt(tabs, path)
  }
  const move = (delta: number): void => {
    if (rows.length === 0) return
    setSelected((active + delta + rows.length) % rows.length)
  }

  return (
    <div className="diorama-palette" data-testid="quick-open" role="dialog" aria-label="快速打开" data-command-keys>
      <div className="diorama-palette__backdrop" onClick={() => hideOverlay(QUICK_OPEN_ID)} />
      <div className="diorama-palette__panel">
        <input
          ref={input}
          className="diorama-palette__input"
          data-testid="quick-open-input"
          placeholder={paths === undefined ? '正在读取文件列表…' : '按文件名跳转…'}
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              hideOverlay(QUICK_OPEN_ID)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const target = rows[active]
              if (target !== undefined) run(target.path)
            }
          }}
        />
        <ul className="diorama-palette__list" role="listbox">
          {rows.map((row, index) => {
            const { dir, name } = splitPath(row.path)
            return (
              <li
                key={row.path}
                role="option"
                aria-selected={index === active}
                className={`diorama-palette__item${index === active ? ' diorama-palette__item--active' : ''}`}
                data-path={row.path}
                data-testid="quick-open-row"
                onMouseEnter={() => setSelected(index)}
                onClick={() => run(row.path)}
              >
                <span className="diorama-search__name">
                  <Segments segments={highlightPositions(name, row.positions.filter(position => position >= row.path.length - name.length).map(position => position - (row.path.length - name.length)))} />
                </span>
                <span className="diorama-palette__id">{dir}</span>
              </li>
            )
          })}
          {rows.length === 0 && paths !== undefined ? (
            <li className="diorama-palette__empty" data-testid="quick-open-empty">
              没有匹配的文件
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  )
}

export function apply(ctx: Context) {
  // A client-only piece: absent in the server tree, where it contributes
  // nothing (and must not fail to activate).
  const commands = clientCommands(ctx)
  if (commands === undefined) return
  provideEntry(
    ctx,
    { id: 'search:view', name: 'sidebar.views', key: SEARCH_VIEW, order: 40, title: '搜索', icon: SEARCH_ICON },
    SearchView,
  )
  provideEntry(ctx, { id: 'search:quick-open', name: 'layout.overlay', order: 300 }, QuickOpen)
  // Opening the view is a command like any other (contract.md §3.7): the
  // switcher's own shortcut lives in `layout` (`sidebar.showSearch`).
  commands.register({
    id: 'search.quickOpen',
    title: '快速打开文件',
    run: () => toggleOverlay(QUICK_OPEN_ID),
  })
  commands.bind({ keys: 'mod+p', command: 'search.quickOpen' })
  commands.register({
    id: 'search.open',
    title: '打开搜索视图',
    run: () => {
      // A command surface that is up would cover the column it opens.
      closeOverlay()
      showSearchView()
    },
  })
  commands.bind({ keys: 'mod+shift+f', command: 'search.open' })
}

/**
 * Every file path of the mount, walked through `fs.list` (the same door the
 * file tree uses). Hidden entries are already absent (contract.md §3.1), so
 * quick open and the tree agree by construction.
 */
async function listFiles(mount: MountHandle, limit = 20_000): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0 && out.length < limit) {
    const directory = queue.shift() as string
    let entries: FileInfo[]
    try {
      entries = await mount.fs.list(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.kind === 'dir') queue.push(entry.path)
      else out.push(entry.path)
    }
  }
  return out
}

/**
 * Ask `layout` to show the search view. The choice is layout's page state
 * (`__diorama_layout__`), not a kernel service: the same hand-off the other
 * views use.
 */
function showSearchView(): void {
  const page = globalThis as unknown as { __diorama_layout__?: { viewChoice?: { show(view: string): void } } }
  page.__diorama_layout__?.viewChoice?.show(SEARCH_VIEW)
}

/**
 * `ctx.commands` when this context is a page (client kernel), else `undefined`.
 * One module serves both halves, and Cordis throws on reading a service that is
 * neither provided nor injected — so the server half asks instead of assuming.
 */
function clientCommands(ctx: Context): { register(spec: unknown): unknown; bind(spec: unknown): unknown } | undefined {
  try {
    return (ctx as unknown as { commands?: { register(spec: unknown): unknown; bind(spec: unknown): unknown } }).commands
  } catch {
    return undefined
  }
}
