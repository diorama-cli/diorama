/**
 * status-bar — the bar under the frame (contract.md §5.4).
 *
 * One entry in the `layout.status` seat that `layout` declares and draws: the
 * bar is a **piece**, like the palette and the shortcut sheet, so a page
 * without it has no bar at all (M0 acceptance point 3 — every piece stays
 * optional).
 *
 * What it answers, left to right:
 *
 * - **the instance** this page is — the mount's directory, its `mountId` (the
 *   same id the CLI prints as `[mount:…]`) and the origin it is served from;
 * - **the file being read** — its path, whether the tab shows the file or its
 *   working-tree diff, its size, its line count and when it last changed;
 * - **how many tabs are open**.
 *
 * It reads nothing from another piece: the handle comes from the page kernel
 * (`mountCtx`), the tab set from `ctx.tabs` when that piece is in the page, and
 * the file's numbers from `ctx.fs` (stat + a capped text read). The bar is
 * decoration — a failure to read a file leaves the cells out rather than
 * covering the page with an error.
 */
import type { Context } from 'cordis'
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { TabsSnapshot, TabsService } from 'diorama-kernel/client'
import type {} from 'diorama-plugin-slots'
import { provideEntry, useKernel } from 'diorama-ui'
import { countLines, displayPath, formatBytes, formatWhen, MAX_LINES_BYTES, splitRoot } from './info.ts'

export const name = 'status-bar'
export const inject = ['slots']

/** The seat this piece fills (declared by `layout`, contract.md §5.4). */
export const STATUS_SEAT = 'layout.status'

/** What an empty page's bar says in the file cell. */
export const NO_FILE_LABEL = '未打开文件'

/** The tab set, for a page that has the `tabs` piece; empty otherwise. */
const NO_TABS: TabsSnapshot = { tabs: [], activeId: undefined }

/** One file's numbers, as the bar shows them. */
interface FileFacts {
  size: number
  /** Milliseconds since epoch (`stat`'s `mtime`). */
  mtime: number
  /** Lines of text, when the file was small enough to count (see `MAX_LINES_BYTES`). */
  lines?: number
}

/** `ctx.tabs` when this page has the `tabs` piece, else `undefined`. */
function clientTabs(ctx: Context): TabsService | undefined {
  try {
    return (ctx as unknown as { tabs?: TabsService }).tabs
  } catch {
    return undefined
  }
}

/** The tab set, re-read on every tab change (a stable snapshot between them). */
function useTabSnapshot(tabs: TabsService | undefined): TabsSnapshot {
  return useSyncExternalStore(
    useCallback((listener: () => void) => tabs?.subscribe(listener) ?? (() => {}), [tabs]),
    useCallback(() => tabs?.getSnapshot() ?? NO_TABS, [tabs]),
    useCallback(() => tabs?.getSnapshot() ?? NO_TABS, [tabs]),
  )
}

/**
 * The numbers of the file a tab shows. Re-read when the tab changes, when the
 * file's directory reports a change to it, and after a reconnect (a file
 * written while the page was offline produced no event, contract.md §4).
 *
 * A failure leaves the cells out: the bar is not a place to report errors, and
 * the tab itself already says what went wrong with a file it cannot read.
 */
function useFileFacts(path: string | undefined): FileFacts | undefined {
  const { mount } = useKernel()
  const [facts, setFacts] = useState<FileFacts | undefined>(undefined)
  useEffect(() => {
    setFacts(undefined)
    if (path === undefined) return
    let live = true
    const read = (): void => {
      mount.fs
        .stat(path)
        .then(info => {
          if (!live) return
          // The size and the time first: they are one call and always right.
          setFacts({ size: info.size, mtime: info.mtime })
          if (info.kind !== 'file' || info.size > MAX_LINES_BYTES) return
          return mount.fs.readText(path).then(text => {
            if (!live) return
            setFacts({ size: info.size, mtime: info.mtime, lines: countLines(text) })
          })
        })
        .catch(() => {
          if (live) setFacts(undefined)
        })
    }
    read()
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const stopWatch = mount.fs.watch(parent, event => {
      if (event.path === path) read()
    })
    const stopReconnect = mount.rpc.onReconnect(read)
    return () => {
      live = false
      stopWatch()
      stopReconnect()
    }
  }, [mount, path])
  return facts
}

/**
 * The bar. Every cell is optional except the instance: a page with no tabs
 * still says which mount it is, and a file that cannot be stat'ed still shows
 * its path (the tab is open; the numbers are what is missing).
 */
function StatusBar(): ReactElement {
  const { mount, ctx } = useKernel()
  const tabs = clientTabs(ctx)
  const snapshot = useTabSnapshot(tabs)
  const active = snapshot.tabs.find(tab => tab.id === snapshot.activeId)
  const path = active?.path
  const facts = useFileFacts(path)
  const when = facts === undefined ? undefined : formatWhen(facts.mtime)
  const origin = mount.baseUrl.replace(/^https?:\/\//, '')
  // The whole served path, not just its last segment (contract.md §5.4): three
  // checkouts can all be called `diorama`, and "which one is this page?" is
  // exactly what the bar is asked. The last segment is what the eye lands on,
  // so it is drawn heavier; the rest is dimmed and truncates from its end.
  const root = splitRoot(mount.root)
  return (
    <div className="diorama-statusbar" data-testid="status-bar">
      <span className="diorama-statusbar__group" data-testid="status-instance">
        <span className="diorama-statusbar__item diorama-statusbar__root" data-testid="status-mount" title={mount.root}>
          <span className="diorama-statusbar__root-parent">{root.parent}</span>
          <span className="diorama-statusbar__root-name">{root.name}</span>
        </span>
        <span className="diorama-statusbar__item" data-testid="status-mount-id" title={`挂载 id：${mount.mountId}`}>
          {mount.mountId}
        </span>
        <span className="diorama-statusbar__item" data-testid="status-origin" title={`页面地址：${mount.baseUrl}`}>
          {origin}
        </span>
      </span>
      <span className="diorama-statusbar__group diorama-statusbar__group--file">
        {path === undefined ? (
          <span className="diorama-statusbar__item" data-testid="status-file">{NO_FILE_LABEL}</span>
        ) : (
          <>
            <span className="diorama-statusbar__item diorama-statusbar__path" data-testid="status-file" title={path}>
              {displayPath(path)}
            </span>
            {active?.view === 'diff' && (
              <span className="diorama-statusbar__badge" data-testid="status-view" title="这个标签页显示工作区的改动">差异</span>
            )}
            {facts !== undefined && (
              <span className="diorama-statusbar__item" data-testid="status-size">{formatBytes(facts.size)}</span>
            )}
            {facts?.lines !== undefined && (
              <span className="diorama-statusbar__item" data-testid="status-lines">{facts.lines} 行</span>
            )}
            {when !== undefined && (
              <span className="diorama-statusbar__item" data-testid="status-mtime" title="最后修改时间">{when}</span>
            )}
          </>
        )}
      </span>
      <span className="diorama-statusbar__group" data-testid="status-tabs">
        <span className="diorama-statusbar__item">{snapshot.tabs.length} 个标签页</span>
      </span>
    </div>
  )
}

export function apply(ctx: Context) {
  // A client-only piece: the server tree has no seats to fill.
  provideEntry(ctx, { id: 'status-bar:bar', name: STATUS_SEAT, order: 100 }, StatusBar)
}
