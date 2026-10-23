/**
 * layout — the split frame.
 *
 * Registers one component into the kernel's `root` seat, declares the seats it
 * owns (`sidebar.views`, `layout.main`, `layout.overlay`) and renders them.
 *
 * The left column is one column with **several views** (contract.md §5.2):
 * every piece registers into `sidebar.views` under a key of its own (`files`,
 * `changes`, …) and this piece draws the switcher between them, the way an
 * editor's activity bar does. The column is drawn only while some view is
 * registered; that is how removing the `file-tree` piece still leaves exactly
 * the empty right side (M0 acceptance point 3). Inactive views stay mounted and
 * hidden, so each keeps its own expansion, scroll and selection.
 *
 * It deliberately owns no seat state: `Slot` reads seats from the page kernel
 * (the bridge), which is installed before this piece ever renders.
 */
import type { Context } from 'cordis'
import type { MountHandle } from 'diorama-kernel'
import type { CommandsService } from 'diorama-kernel/client'
import { useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { provideEntry, Slot, Splitter, useKeyedSeat, usePaneSize } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'
import type { SidebarViewProps, SlotEntry } from 'diorama-plugin-slots'

export const name = 'layout'
export const inject = ['slots']

/** Props of the `root` entry. */
export interface LayoutRootProps {
  mountCtx: MountHandle
}

/** The view shown when the page has not chosen one (contract.md §5.2). */
export const DEFAULT_VIEW = 'files'

/** Where the column's width is remembered (`localStorage`, like the theme's). */
export const SIDEBAR_WIDTH_KEY = 'diorama.layout.sidebarWidth'

/** The width the column starts at, before the reader drags its edge (px). */
export const SIDEBAR_DEFAULT_PX = 260

/**
 * Which view the column shows. Page-level state, not a component's: the
 * switcher, the `sidebar.show*` commands (contract.md §3.7) and the view's
 * hash flag (§3.8) all name the same choice, and only one of them may hold it.
 */
class ViewChoice {
  private chosen: string | undefined
  private version = 0
  private readonly listeners = new Set<() => void>()
  private known = new Set<string>()

  /**
   * The store's snapshot, as a bound function: this object is handed to other
   * pieces as the page's layout face, and a method read off it detached would
   * lose `this` (a field arrow keeps it).
   */
  getSnapshot = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The chosen view, or `undefined` for "whatever comes first". */
  get(): string | undefined {
    return this.chosen
  }

  /**
   * A number that changes whenever the choice does: the snapshot other pieces
   * subscribe to. `get()` alone is not enough — a piece reading it re-renders
   * only when something it *snapshots* changes, and "history → changes" leaves
   * the tab set untouched.
   */
  getVersion(): number {
    return this.version
  }

  /** Called after every change (the face other pieces subscribe through). */
  onChange(listener: () => void): () => void {
    return this.subscribe(listener)
  }

  /**
   * The view the column is **showing**: the choice while it is registered, else
   * the fallback the column itself uses (`DEFAULT_VIEW` when present, else the
   * first registered view). Pieces that have to know "is the reader still on
   * the history?" ask this, not `get()` (which may name a gone view) and not
   * `available()` (which stays true while the column shows something else).
   */
  shown(fallback = DEFAULT_VIEW): string | undefined {
    const chosen = this.chosen
    if (chosen !== undefined && this.known.has(chosen)) return chosen
    return this.known.has(fallback) ? fallback : this.known.values().next().value
  }

  /**
   * Record which views exist right now. The switcher calls this as it
   * renders; the commands ask `available()` so that "show the history" is not
   * executable on a directory with no repository (the piece never registered
   * the view there). No notify: the switcher's own render is the update.
   */
  register(keys: readonly string[]): void {
    this.known = new Set(keys)
  }

  /** Whether a view id is currently registered (a command's `when`). */
  available(key: string): boolean {
    return this.known.has(key)
  }

  show(view: string): void {
    if (this.chosen === view) return
    this.chosen = view
    this.notify()
  }

  private notify(): void {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }
}

const viewChoice = new ViewChoice()

/** The store's snapshot, as a stable function (see `ViewChoice.getSnapshot`). */
const viewVersion = (): number => viewChoice.getSnapshot()

/**
 * Publish the column's choice on the page. Each half is its own build, so a
 * piece in another half (one that has to know "is the reader still on the
 * history view?", say) cannot share this module's object by importing it; the
 * page's `globalThis` is the one place both halves see the same thing. Read
 * lazily by those pieces — this is page state, not a kernel service.
 */
function publishViewChoice(): void {
  const page = globalThis as unknown as { __diorama_layout__?: { viewChoice: ViewChoice } }
  page.__diorama_layout__ = { viewChoice }
}

/**
 * The side column's views, keyed by id, are `files` / `changes` / `history` /
 * `search` (contract.md §3.7): the commands below are fixed, not one per
 * registered view.
 */
const SIDEBAR_COMMANDS = [
  { id: 'sidebar.showFiles', key: 'files', title: '侧栏：文件', keys: 'mod+alt+1' },
  { id: 'sidebar.showChanges', key: 'changes', title: '侧栏：变更', keys: 'mod+alt+2' },
  { id: 'sidebar.showHistory', key: 'history', title: '侧栏：历史', keys: 'mod+alt+3' },
  { id: 'sidebar.showSearch', key: 'search', title: '侧栏：搜索', keys: 'mod+alt+4' },
] as const

/** The view ids whose hash flags `layout` honours on boot (contract.md §3.8). */
const SIDEBAR_KEYS = SIDEBAR_COMMANDS.map(command => command.key)

function SeatError({ label, message, testId }: { label: string; message: string; testId: string }) {
  return (
    <div className="diorama-layout__seat-error" role="alert" data-testid={testId}>
      {label}加载失败：{message}
    </div>
  )
}

/** The `layout` owner declares (and thereby claims) the frame's seats. */
const DECLARE = {
  // One column, many views: the key is the view id (contract.md §5.2).
  'sidebar.views': { kind: 'keyed' },
  'layout.main': { kind: 'single' },
  // The overlay seat (contract.md §5, v0.7): every command surface draws here,
  // above the frame and outside it, and they take turns rather than stack
  // (the page-global `overlayStore` in `diorama-ui` decides which one is up).
  'layout.overlay': { kind: 'list' },
} as const

/**
 * The views of `sidebar.views`.
 *
 * Read through the page bridge, not through `ctx.slotRegistry`: the snapshot
 * must be **stable between changes** (React re-renders forever otherwise), and
 * the bridge caches per version. The registry object is also the wrong source
 * here — the kernel installs its page context after the first pieces apply, so
 * a registry read during an early render may be a different object each time.
 */
function useSidebarViews(): readonly SlotEntry<'sidebar.views'>[] {
  return useKeyedSeat('sidebar.views') as readonly SlotEntry<'sidebar.views'>[]
}

/** The view switcher: one button per registered view, in entry order. */
function ViewSwitcher({
  views,
  active,
  onPick,
}: {
  views: readonly SlotEntry<'sidebar.views'>[]
  active: string | undefined
  onPick(view: string): void
}) {
  return (
    <nav className="diorama-sidebar__views" role="tablist" aria-label="侧栏视图" data-testid="sidebar-switcher">
      {views.map(view => {
        const key = view.key ?? ''
        const title = view.title ?? key
        const selected = key === active
        return (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={selected}
            title={title}
            aria-label={title}
            className={`diorama-sidebar__view${selected ? ' diorama-sidebar__view--active' : ''}`}
            data-view={key}
            data-testid="sidebar-view"
            onClick={() => onPick(key)}
          >
            {view.icon === undefined ? (
              <span aria-hidden="true">{title.slice(0, 1)}</span>
            ) : (
              // Inline SVG authored by the piece that owns the view.
              <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: view.icon }} />
            )}
          </button>
        )
      })}
    </nav>
  )
}

/** One view's content; `active` tells the view whether it is the visible one. */
function SidebarView({ view, active }: { view: SlotEntry<'sidebar.views'>; active: boolean }) {
  const View = view.component as unknown as (props: SidebarViewProps) => ReactElement | null
  return <View active={active} />
}

/**
 * The left column: the switcher plus one pane per view. The active view is
 * layout's own state; a choice that is no longer registered falls back to the
 * first view, so removing a piece never leaves the column blank.
 */
function Sidebar({ views }: { views: readonly SlotEntry<'sidebar.views'>[] }) {
  // The column's own state (view choice) is below; its **width** belongs to the
  // frame that lays it out (see `SplitFrame`).
  // The store's version is the snapshot: the chosen id itself is read separately,
  // so the snapshot is a number and never a fresh object (React #185).
  // The third argument (the server snapshot) is the same number: the shell
  // server-renders the page first, and React requires one to do it.
  useSyncExternalStore(viewChoice.subscribe, viewVersion, viewVersion)
  // Publish the store as the page's layout face once this column exists: pieces
  // in other halves read it (never import it — each half is its own build).
  useLayoutEffect(publishViewChoice, [])
  const chosen = viewChoice.get()
  const keys = views.map(view => view.key ?? '')
  viewChoice.register(keys)
  // `active` drives the views' `props.active`; it is computed on every render
  // from the store, so a command's change reaches the views in the same pass.
  const setChosen = (view: string): void => viewChoice.show(view)
  const active = chosen !== undefined && keys.includes(chosen) ? chosen : (keys.includes(DEFAULT_VIEW) ? DEFAULT_VIEW : keys[0])
  if (views.length === 0) return null
  return (
    <aside className="diorama-layout__sidebar" data-slot="sidebar.views">
      <ViewSwitcher views={views} active={active} onPick={setChosen} />
      <div className="diorama-sidebar__panes">
        {views.map(view => (
          <div
            key={view.id}
            className="diorama-sidebar__pane"
            data-view={view.key}
            data-testid="sidebar-pane"
            // Inactive views stay mounted (contract.md §5.2): expansion, scroll
            // and selection are theirs to keep.
            style={view.key === active ? undefined : { display: 'none' }}
          >
            {/* `active` is passed as a plain boolean, never a fresh object:
                a new props object on every render remounts the view. */}
            {view.key === active ? <SidebarView view={view} active /> : <SidebarView view={view} active={false} />}
          </div>
        ))}
      </div>
    </aside>
  )
}

function MainColumn() {
  return (
    <main className="diorama-layout__main" data-slot="layout.main">
      <Slot
        name="layout.main"
        empty={null}
        exhausted={errors => <SeatError testId="layout-main-error" label="主区域" message={errors.join('；')} />}
        render={entry => {
          const Main = entry.component as unknown as (props: object) => ReactElement | null
          return <Main />
        }}
      />
    </main>
  )
}

/**
 * The page frame. A seat is drawn only while it has an occupant, so every piece
 * stays optional (M0 acceptance point 3). `useSidebarViews()` answers "is the
 * column drawn?" without rendering the seat, which would re-enter it.
 */
function SplitFrame() {
  const views = useSidebarViews()
  // The column's width is the frame's (it is what lays the column out), and it
  // is a **preference**: remembered in `localStorage`, clamped by the primitive
  // in `diorama-ui`, and adjustable by dragging the edge or with the arrow keys
  // on it. A fixed 260px was the old answer (docs/m4/spec.md §6.4); long file
  // names made it the wrong one.
  const [width, setWidth] = usePaneSize(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_PX)
  const frame = useRef<HTMLDivElement | null>(null)
  // While the pointer is down only the CSS variable moves (see `splitpane`):
  // re-rendering the column on every frame would re-render the whole tree.
  const preview = (next: number): void => {
    frame.current?.style.setProperty('--dio-sidebar-width', `${next}px`)
  }
  if (views.length > 0) {
    return (
      <div
        ref={frame}
        className="diorama-layout diorama-layout--split"
        data-layout="split"
        style={{ '--dio-sidebar-width': `${width}px` } as CSSProperties}
      >
        <Sidebar views={views} />
        <Splitter
          side="start"
          size={width}
          onPreview={preview}
          onCommit={setWidth}
          label="调整侧栏宽度"
          testId="sidebar-splitter"
        />
        <MainColumn />
      </div>
    )
  }
  return (
    <div className="diorama-layout" data-layout="main-only">
      <MainColumn />
    </div>
  )
}

/**
 * Whatever occupies `layout.overlay` (the palette, the shortcut sheet, …).
 *
 * A **list** seat (contract.md §5, v0.7): every registered overlay is rendered,
 * and each decides from the page's overlay store whether it is the one that is
 * up. Rendering all of them (rather than only the open one) is what lets an
 * overlay keep its own state — the sheet's scroll, the palette's query — across
 * a close and a reopen, the same "hidden, not unmounted" rule as `sidebar.views`
 * and `tabs.content`.
 */
function Overlay() {
  return (
    <Slot
      name="layout.overlay"
      list
      empty={null}
      exhausted={() => null}
      render={entry => {
        const OverlayEntry = entry.component as unknown as (props: object) => ReactElement | null
        return <OverlayEntry />
      }}
    />
  )
}

function LayoutRoot(_props: LayoutRootProps) {
  return (
    <>
      <SplitFrame />
      <Overlay />
    </>
  )
}

export function apply(ctx: Context) {
  provideEntry(ctx, { id: 'layout:root', name: 'root', order: 0, declare: DECLARE }, LayoutRoot)

  // The switcher's keyboard entry points (contract.md §3.7, v0.6). `layout`
  // registers them because it is the one that holds the choice; a view without
  // a command (a third-party one) simply has no shortcut.
  // A view named in the URL's hash (`#history=<sha>`, contract.md §3.8) is the
  // one to show after a refresh: the piece wrote it because the user was there.
  // `layout` only sees keys it knows; the writer is the view's own piece.
  trackViewInHash(ctx)

  const commands = clientCommands(ctx)
  if (commands === undefined) return
  for (const command of SIDEBAR_COMMANDS) {
    commands.register({
      id: command.id,
      title: command.title,
      // A view that is not registered cannot be shown: the command is then not
      // executable (absent from the palette, and its keys do nothing, §3.7).
      when: () => viewChoice.available(command.key),
      run: () => viewChoice.show(command.key),
    })
    commands.bind({ keys: command.keys, command: command.id })
  }
}

/**
 * Show the view whose key a hash entry names, when one is registered. The keys
 * are this column's well-known ones (contract.md §3.7); a piece's own extra
 * hash keys are its business and are not looked at here.
 */
function trackViewInHash(ctx: Context): void {
  let router: { state(key: string): { get(): string | undefined } } | undefined
  try {
    router = (ctx as unknown as { router?: typeof router }).router
  } catch {
    return
  }
  if (router === undefined) return
  for (const key of SIDEBAR_KEYS) {
    const slot = router.state(key)
    if (slot.get() !== undefined) {
      viewChoice.show(key)
      return
    }
  }
}

/** `ctx.commands` when this context is a page (client kernel), else `undefined`.
 * One module serves both halves, and Cordis throws on reading a service that is
 * neither provided nor injected.
 */
function clientCommands(ctx: Context): CommandsService | undefined {
  try {
    return (ctx as unknown as { commands?: CommandsService }).commands
  } catch {
    return undefined
  }
}
