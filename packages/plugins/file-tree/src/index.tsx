/**
 * file-tree — the left navigation column.
 *
 * Provides `ctx.tree` and is the only client piece that lists directories: it
 * calls `mountCtx.fs.list` lazily as directories are expanded and hands the
 * chosen file to `ctx.tabs` through `ctx.tree`. Removing this piece removes
 * the column entirely; the layout must not depend on it (M0 acceptance point
 * 3).
 *
 * Hiding is **not** done here: `fs.list` already omits every entry the
 * `ignore` rules hide (contract.md §3.1, §4.1), so the tree, any future file
 * search and the server agree by construction.
 *
 * Large directories: a directory with many entries lists its first
 * `PAGE_SIZE` and offers 「加载更多」. This is not the `ignore` rule (those
 * entries are gone); it only keeps rendering bounded.
 *
 * The view has a **toolbar** of its own at the top (contract.md §35): one
 * button, 「定位到正在浏览的文件」, which expands the way to the active tab's
 * file and scrolls its row into view. The toolbar belongs to this view, not to
 * the column: a view's controls live inside the view's own pane (§5.2), so the
 * other views are untouched.
 */
import type { Context } from 'cordis'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { FileInfo, MountHandle, TabsSnapshot } from 'diorama-kernel/client'
import { createTreeService, rawUrl, type CommandsService } from 'diorama-kernel/client'
import { bindMethods, ContextMenu, FileIcon, Icon, iconSvg, provideEntry, useKernel, useStore, type MenuItem, type Store } from 'diorama-ui'
import { FILE_ACTIONS, fileCommand, runFileAction, type FileActionOutcome } from './actions.ts'
import { browserFileActionHost } from './host.ts'

export const name = 'file-tree'
export const inject = ['slots']

/** Entries a collapsed-until-asked directory shows at first (M2). */
export const PAGE_SIZE = 500

/**
 * The switcher icon (contract.md §5.2; `layout` draws it verbatim). Built from
 * the page's button table (docs/m7/spec.md §3), so the activity bar is one
 * family of glyphs; `iconSvg` answers `''` in a page with no table, and the
 * switcher then falls back to the title's first character as it always has.
 */
export const FILES_ICON = iconSvg('files')

/**
 * The toolbar button's glyph (contract.md §35): Tabler's `current-location`,
 * the "you are here" target an editor uses for "reveal the active file".
 */
export const REVEAL_ICON = iconSvg('reveal-file')

/** The command behind the toolbar button (contract.md §3.7, §35). */
export const REVEAL_COMMAND = 'tree.revealActive'

/** What the toolbar button says (also the command's title). */
export const REVEAL_TITLE = '定位到正在浏览的文件'

/** A page with no tab open: the toolbar has nothing to locate. */
const NO_TABS: TabsSnapshot = { tabs: [], activeId: undefined }

/** The store a page without the `tabs` piece reads instead (constant snapshot). */
const TABS_ABSENT: Store<TabsSnapshot> = {
  subscribe: () => () => {},
  getSnapshot: () => NO_TABS,
}

interface DirState {
  entries?: FileInfo[]
  error?: string
}

/** Directories first, then names (locale-aware, case-insensitive, stable). */
function compareEntries(a: FileInfo, b: FileInfo): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
}

/**
 * One directory's entries, fetched when it is first drawn. `limit` starts at
 * `PAGE_SIZE` and only grows; the full (already filtered) list is kept so
 * 「加载更多」 does not re-list.
 */
function useDirectory(
  mount: MountHandle,
  path: string,
  open: boolean,
  ensure?: string,
): DirState & { visible: number; more(batch?: number): void } {
  const [state, setState] = useState<DirState>({})
  const [visible, setVisible] = useState(PAGE_SIZE)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let reload = (): void => {}
    const load = (): void => {
      mount.fs.list(path).then(
        entries => {
          if (!cancelled) setState({ entries: [...entries].sort(compareEntries) })
        },
        (error: unknown) => {
          if (!cancelled) setState({ error: error instanceof Error ? error.message : String(error) })
        },
      )
    }
    load()
    // A change in this directory re-lists it: create / delete / rename all
    // change the entry set, and `change` may be the first event of a file that
    // was just created (the kind is only a hint, contract.md §3.1, U2).
    reload = mount.fs.watch(path, () => load())
    // A reconnect is not a directory event (contract.md §4): anything created or
    // deleted while the page was offline was never reported, so list once more.
    const stopReconnect = mount.rpc.onReconnect(() => {
      if (!cancelled) load()
    })
    return () => {
      cancelled = true
      stopReconnect()
      reload()
    }
  }, [mount, path, open])
  const more = useCallback((batch = PAGE_SIZE) => setVisible(current => current + batch), [])
  // A locate request for an entry past the first page grows the page until the
  // row is drawn (contract.md §35): a row that does not exist cannot be
  // scrolled to, and 「加载更多」 is the reader's gesture for the same thing.
  useEffect(() => {
    if (ensure === undefined || state.entries === undefined) return
    const index = state.entries.findIndex(entry => entry.path === ensure)
    if (index >= visible) setVisible(index + 1)
  }, [ensure, state.entries, visible])
  return { ...state, visible, more }
}

/** The directory an entry sits in (`a/b/c.md` → `a/b`, `README.md` → ``). */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * The row a locate request names (contract.md §35), as a stable stamp: the
 * effect below runs on `at`, so pressing the button twice scrolls twice even
 * though the path did not change.
 */
function useLocated(
  path: string,
  reveal: { path: string; at: number } | undefined,
): { located: boolean; ref: RefObject<HTMLButtonElement | null> } {
  const located = reveal !== undefined && reveal.path === path
  const at = located ? reveal.at : undefined
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (at === undefined) return
    // The pane scrolls (contract.md §5.2); `scrollIntoView` moves the nearest
    // scrollable ancestor, which is that pane, and leaves the page alone.
    ref.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [at])
  return { located, ref }
}

function TreeRow({
  mountCtx,
  file,
  depth,
  reveal,
  onMenu,
}: {
  mountCtx: MountHandle
  file: FileInfo
  depth: number
  reveal: { path: string; at: number } | undefined
  /** Open the file's context menu at a viewport point (contract.md §36). */
  onMenu(file: FileInfo, x: number, y: number): void
}) {
  const { ctx } = useKernel()
  const tree = ctx.tree
  const snapshot = useStore(tree)
  const isDir = file.kind === 'dir'
  const expanded = isDir && snapshot.expanded.includes(file.path)
  const selected = !isDir && snapshot.selected === file.path
  // The row to make visible, when this directory is the one holding it.
  const ensure = reveal !== undefined && parentOf(reveal.path) === file.path ? reveal.path : undefined
  const dirState = useDirectory(mountCtx, file.path, expanded, ensure)
  const total = dirState.entries?.length ?? 0
  const cut = Math.min(dirState.visible, total)
  const { located, ref } = useLocated(file.path, reveal)

  /**
   * A file row's menu (contract.md §36). Directories keep the browser's own
   * menu: there is nothing to download, link or open about one — the three
   * actions are about bytes, and a directory has none.
   *
   * Right-clicking **changes nothing**: not the selection, not the active tab,
   * not the URL (the same rule as locating the browsed file, §35). The reader
   * is asking a question about the row, not navigating to it.
   */
  const openMenu = (event: { clientX: number; clientY: number; preventDefault(): void }): void => {
    if (isDir) return
    event.preventDefault()
    onMenu(file, event.clientX, event.clientY)
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`diorama-tree__row${selected ? ' diorama-tree__row--selected' : ''}${located ? ' diorama-tree__row--located' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-path={file.path}
        data-kind={file.kind}
        data-located={located ? 'true' : undefined}
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected}
        title={file.path}
        onClick={() => (isDir ? tree.toggle(file.path) : tree.select(file))}
        onContextMenu={openMenu}
        // The keyboard's way to the same menu: `ContextMenu` is the key most
        // keyboards call Menu, and Shift+F10 is the one that always exists.
        onKeyDown={event => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            const box = event.currentTarget.getBoundingClientRect()
            onMenu(file, box.left + 24, box.top + box.height)
          }
        }}
      >
        <span className="diorama-tree__caret" aria-hidden="true">
          {isDir ? <Icon name={expanded ? 'caret-down' : 'caret-right'} size={14} /> : null}
        </span>
        <FileIcon name={file.name} kind={file.kind} expanded={expanded} />
        <span className="diorama-tree__name">{file.name}</span>
      </button>
      {expanded && dirState.error !== undefined && (
        <div className="diorama-tree__error" style={{ paddingLeft: 22 + depth * 14 }}>
          {dirState.error}
        </div>
      )}
      {expanded &&
        dirState.entries?.slice(0, cut).map(child => (
          <TreeRow key={child.path} mountCtx={mountCtx} file={child} depth={depth + 1} reveal={reveal} onMenu={onMenu} />
        ))}
      {expanded && cut < total && (
        <button
          type="button"
          className="diorama-tree__more"
          style={{ paddingLeft: 8 + (depth + 1) * 14 }}
          data-path={file.path}
          data-testid="tree-more"
          onClick={() => dirState.more()}
        >
          <Icon name="caret-down" size={14} />
          加载更多（已显示 {cut} / 共 {total} 条）
        </button>
      )}
    </>
  )
}

/**
 * The view's toolbar (contract.md §35): a strip of the view's own, pinned to
 * the top of its pane. Its buttons act on **the view** — not on the file being
 * read (that is the renderer's own header), and not on the column (that is the
 * switcher's rail).
 */
function TreeToolbar({ onReveal, disabled }: { onReveal(): void; disabled: boolean }) {
  return (
    <div className="diorama-tree__toolbar" role="toolbar" aria-label="文件视图工具栏" data-testid="file-tree-toolbar">
      <button
        type="button"
        className="diorama-tree__tool"
        title={disabled ? '没有正在浏览的文件' : REVEAL_TITLE}
        aria-label={REVEAL_TITLE}
        data-testid="file-tree-reveal"
        disabled={disabled}
        onClick={onReveal}
      >
        {REVEAL_ICON === '' ? (
          // No icon table on this page (an external host, a unit test): the
          // switcher's own fallback rule — a character — rather than a blank.
          <span aria-hidden="true">定</span>
        ) : (
          <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: REVEAL_ICON }} />
        )}
      </button>
    </div>
  )
}

function FileTreeRoot({ active = true }: { active?: boolean }) {
  const { ctx, mount: mountCtx } = useKernel()
  const tree = ctx.tree
  const snapshot = useStore(tree)
  // The root lists on demand too: a located row may be on a later page.
  const ensureRoot = snapshot.reveal !== undefined && parentOf(snapshot.reveal.path) === '' ? snapshot.reveal.path : undefined
  const rootEntries = useDirectory(mountCtx, '', true, ensureRoot)
  const total = rootEntries.entries?.length ?? 0
  const cut = Math.min(rootEntries.visible, total)
  // Selecting a file opens it: the tab service is the only opener. `ctx` here is
  // the page's kernel context (installed before pieces render), so it carries
  // the live services.
  useEffect(() => tree.onSelect(file => ctx.tabs.open(file)), [ctx, tree])
  // The file being browsed is the active tab's (contract.md §3.4). Read from
  // the service rather than passed down: the toolbar needs to know whether it
  // has anywhere to go, and a page without the `tabs` piece still draws the
  // tree (a constant, empty store keeps the hook order unchanged).
  const tabs = useStore(clientTabs(ctx) ?? TABS_ABSENT)
  const activeTab = tabs.tabs.find(tab => tab.id === tabs.activeId)
  // A diff tab names the same file; the tree row is the file either way.
  const activePath = activeTab?.path
  const locate = useCallback(() => {
    if (activePath !== undefined) tree.reveal(activePath)
  }, [tree, activePath])
  // The row menu (contract.md §36) is one menu for the whole view: a right-click
  // replaces the target rather than stacking panels. Hooks stay above the early
  // returns — a conditional hook takes the subtree down (docs/m15/spec.md §6).
  const [menu, setMenu] = useState<{ file: FileInfo; x: number; y: number } | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const openMenu = useCallback((file: FileInfo, x: number, y: number) => {
    setNotice(undefined)
    setMenu({ file, x, y })
  }, [])
  const closeMenu = useCallback(() => setMenu(undefined), [])
  const host = browserFileActionHost()
  const menuItems: MenuItem[] =
    menu === undefined
      ? []
      : FILE_ACTIONS.map(action => ({
          id: action.id,
          label: action.label,
          hint: action.hint,
          run: () => {
            // The URL is built here, from the mount the view already holds: the
            // action table itself imports nothing (see `actions.ts`).
            void runFileAction(action.id, rawUrl(mountCtx.baseUrl, menu.file.path), host).then(outcome => {
              // A refusal is shown, never swallowed: the URL is what the reader
              // wanted and it is right there to copy by hand.
              setNotice(outcome.ok ? undefined : outcome.message)
            })
          },
        }))
  // The view stays mounted while inactive (contract.md §5.2); `aria-hidden`
  // keeps a hidden pane out of the accessibility tree and its buttons untabbable.
  return (
    <div className="diorama-tree-view" aria-hidden={active ? undefined : true}>
      <TreeToolbar onReveal={locate} disabled={activePath === undefined} />
      {notice !== undefined && (
        <div className="diorama-tree__notice" role="status" data-testid="file-action-notice">
          {notice}
        </div>
      )}
      {menu !== undefined && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.file.path}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
      <nav className="diorama-tree" aria-label="文件树" data-testid="file-tree">
        {rootEntries.error !== undefined && <div className="diorama-tree__error">{rootEntries.error}</div>}
        {rootEntries.entries?.slice(0, cut).map(file => (
          <TreeRow key={file.path} mountCtx={mountCtx} file={file} depth={0} reveal={snapshot.reveal} onMenu={openMenu} />
        ))}
        {cut < total && (
          <button type="button" className="diorama-tree__more" data-testid="tree-more" onClick={() => rootEntries.more()}>
            <Icon name="caret-down" size={14} />
            加载更多（已显示 {cut} / 共 {total} 条）
          </button>
        )}
      </nav>
    </div>
  )
}

export function apply(ctx: Context) {
  // See `tabs`: the service face comes from the kernel so every build agrees.
  // Bind: this half runs its own build of the service class (see `tabs`).
  ctx.provide('tree', bindMethods(createTreeService()))
  // The tree is one view of the left column (contract.md §5.2), not the column.
  provideEntry(
    ctx,
    { id: 'file-tree:nav', name: 'sidebar.views', key: 'files', order: 10, title: '文件', icon: FILES_ICON },
    FileTreeRoot,
  )

  // `tree.focus` (contract.md §3.7): the tree owns the command that moves
  // focus into it, and the tree is where focus lands.
  // `commands` is kernel *client* infrastructure (contract.md §3.7). The same
  // module is also loaded as this piece's server half, where it does not exist,
  // so it is read opportunistically and the server half stops here.
  const commands = clientCommands(ctx)
  if (commands === undefined) return
  commands.register({
    id: 'tree.focus',
    title: '聚焦文件树',
    when: context => context.focus !== 'tree',
    // (With nothing focused — `other` — focusing the tree is still useful.)
    run: () => {
      const first = document.querySelector<HTMLElement>('[data-testid="file-tree"] [data-path]')
      first?.focus()
    },
  })
  commands.bind({ keys: 'mod+alt+f', command: 'tree.focus' })
  // Locating the file being browsed (contract.md §35) is a command as well as
  // the toolbar button: the same action, reachable from the palette and from
  // the keyboard. `when` says there has to be a file to locate (no tab open =
  // nothing to find); the command is not executable then, which is the same
  // rule the tab commands use.
  commands.register({
    id: REVEAL_COMMAND,
    title: REVEAL_TITLE,
    when: context => context.activeTab !== undefined,
    run: context => {
      if (context.activeTab !== undefined) ctx.tree.reveal(context.activeTab.path)
    },
  })
  commands.bind({ keys: 'mod+shift+l', command: REVEAL_COMMAND })

  // The three file actions are commands too (contract.md §3.7, §36): the same
  // work the context menu does, reachable from the palette and from a key. They
  // act on the **active tab's file**, which is the only file a page-level
  // command can name — the menu is the way to reach a row that is not open.
  //
  // No keys are bound: `mod+d` (bookmark), `mod+c` (copy) and `mod+o` (open)
  // are the browser's own and mean something else here; the palette is where
  // these three are looked up.
  const host = browserFileActionHost()
  for (const action of FILE_ACTIONS) {
    commands.register({
      id: fileCommand(action.id),
      title: '文件：' + action.label,
      when: context => context.activeTab !== undefined,
      run: async context => {
        const tab = context.activeTab
        if (tab === undefined) return
        const outcome: FileActionOutcome & { url: string } = await runFileAction(
          action.id,
          rawUrl(ctx.mount.baseUrl, tab.path),
          host,
        )
        // A page-level action has no menu row to write into: a refusal is a
        // console line (its message carries the URL, so it can still be used),
        // never a silent no-op.
        if (!outcome.ok) console.warn('[diorama] ' + action.label + ': ' + (outcome.message ?? 'failed'))
      },
    })
  }
}

/**
 * `ctx.commands` when this context is a page (client kernel), else `undefined`.
 * One module serves both halves, and Cordis throws on reading a service that is
 * neither provided nor injected — so the server half asks instead of assuming.
 */
function clientCommands(ctx: Context): CommandsService | undefined {
  try {
    return (ctx as unknown as { commands?: CommandsService }).commands
  } catch {
    return undefined
  }
}

/** `ctx.tabs` when this page has the `tabs` piece, else `undefined`. */
function clientTabs(ctx: Context): Store<TabsSnapshot> | undefined {
  try {
    return (ctx as unknown as { tabs?: Store<TabsSnapshot> }).tabs
  } catch {
    return undefined
  }
}
