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
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { iconSvg, KeyHint, provideEntry, Slot, Splitter, useHeldModifier, useKeyedSeat, useKernel, usePaneSize } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'
import type { SidebarViewProps, SlotEntry } from 'diorama-plugin-slots'
import { readFolded, SIDEBAR_RAIL_PX, storeFolded } from './sidebar.ts'

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
 * The two glyphs of the fold button (`sidebar.toggleFolded`): the page's button
 * table, like every other switcher icon (docs/m7/spec.md §3). They are read at
 * module load, so a page with no table gets `''` and the button falls back to
 * its title's first character (contract.md §5.2).
 */
export const SIDEBAR_FOLD_ICON = iconSvg('sidebar-fold')
export const SIDEBAR_UNFOLD_ICON = iconSvg('sidebar-unfold')

/** The command that folds / unfolds the column (contract.md §3.7). */
export const SIDEBAR_FOLD_COMMAND = 'sidebar.toggleFolded'

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

  /** Whether the column currently has any view at all (a command's `when`). */
  any(): boolean {
    return this.known.size > 0
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
 * Whether the column is folded (contract.md §5.2, v0.13).
 *
 * A store of its own, not a field of `ViewChoice`: folding is **not** choosing
 * a view. The reader folds the column while reading, unfolds it, and expects
 * the view they had — and a view command (or the URL hash) must not silently
 * unfold it either. Same shape as `ViewChoice` (a number as the snapshot, a
 * bound getter) so a component can subscribe to it the same way.
 */
class FoldChoice {
  private folded: boolean
  private version = 0
  private readonly listeners = new Set<() => void>()

  constructor() {
    // Read once, at module load: this is a preference, and a reload should come
    // back the way the reader left it (a blocked storage means "open").
    this.folded = readFolded()
  }

  getSnapshot = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Whether the column is folded right now. */
  get(): boolean {
    return this.folded
  }

  getVersion(): number {
    return this.version
  }

  /** Fold / unfold, and remember it. */
  toggle(): boolean {
    this.set(!this.folded)
    return this.folded
  }

  /** Set the state (the button and the command both end up here). */
  set(folded: boolean): void {
    if (this.folded === folded) return
    this.folded = folded
    storeFolded(folded)
    this.version++
    for (const listener of [...this.listeners]) listener()
  }
}

const foldChoice = new FoldChoice()

/** The store's snapshot, as a stable function (see `FoldChoice.getSnapshot`). */
const foldVersion = (): number => foldChoice.getSnapshot()

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

/**
 * The view switcher: one button per registered view, in entry order.
 *
 * An icon is also the column's fold handle (contract.md §5.2): the one that is
 * already showing folds the column, the others switch to their view. The
 * tooltip says so, because "press the active icon again" is not something a
 * reader can guess from the artwork alone.
 */
function ViewSwitcher({
  views,
  active,
  folded,
  held,
  hintOf,
  onPick,
}: {
  views: readonly SlotEntry<'sidebar.views'>[]
  active: string | undefined
  folded: boolean
  /** The modifier the reader is holding (contract.md §3.7, v0.15). */
  held: 'mod' | 'alt' | undefined
  /** The key a view's command answers (label to show, canonical to test). */
  hintOf(view: string): { label: string; keys: string } | undefined
  onPick(view: string): void
}) {
  return (
    <nav className="diorama-sidebar__views" role="tablist" aria-label="侧栏视图" data-testid="sidebar-switcher">
      {views.map(view => {
        const key = view.key ?? ''
        const title = view.title ?? key
        const selected = key === active
        // The tooltip names the fold gesture for the icon that is already up
        // (the accessible name stays the view's own: `aria-label` below).
        const tooltip = selected ? (folded ? title + '（点击展开侧栏）' : title + '（再点收起侧栏）') : title
        // The shortcut is drawn beside the icon, never merged into the title:
        // the chip is decoration (it goes when the modifier is released) while
        // the title stays the button's accessible name (contract.md §3.7).
        const hint = hintOf(key)
        return (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={selected}
            title={tooltip}
            aria-label={title}
            className={`diorama-sidebar__view${selected ? ' diorama-sidebar__view--active' : ''}`}
            data-view={key}
            data-testid="sidebar-view"
            onClick={() => onPick(key)}
          >
            {view.icon === undefined || view.icon === '' ? (
              // No artwork: an external piece that authored none, or a page
              // that installed no icon table — `iconSvg` returns `''` there
              // (contract.md §5.2). An empty span would be an invisible button.
              <span aria-hidden="true">{title.slice(0, 1)}</span>
            ) : (
              // Inline SVG authored by the piece that owns the view.
              <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: view.icon }} />
            )}
            <KeyHint label={hint?.label} keys={hint?.keys} held={held} />
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
 * The fold button, at the foot of the switcher: it sits where the switcher
 * already is, so folding the column does not take its own control away with it
 * (contract.md §5.2). `aria-expanded` says which way it goes, `aria-controls`
 * points at the panes it hides.
 */
function FoldButton({ folded, onToggle }: { folded: boolean; onToggle(): void }) {
  const label = folded ? '展开侧栏' : '收起侧栏'
  const icon = folded ? SIDEBAR_UNFOLD_ICON : SIDEBAR_FOLD_ICON
  return (
    <button
      type="button"
      className="diorama-sidebar__view diorama-sidebar__fold"
      aria-expanded={!folded}
      aria-controls="diorama-sidebar-panes"
      title={label}
      aria-label={label}
      data-testid="sidebar-fold"
      onClick={onToggle}
    >
      {icon === '' ? (
        // No icon table on this page (an external host, a unit test): the
        // switcher's own fallback rule — the title's first character — rather
        // than an invisible button (contract.md §5.2).
        <span aria-hidden="true">{label.slice(0, 1)}</span>
      ) : (
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />
      )}
    </button>
  )
}

/**
 * The left column: the switcher plus one pane per view. The active view is
 * layout's own state; a choice that is no longer registered falls back to the
 * first view, so removing a piece never leaves the column blank.
 *
 * The column can be **folded** (contract.md §5.2): the switcher stays, the
 * panes go. The state is a preference of the reader's, held here and remembered
 * across reloads; the frame reads it for the width, so it is passed down rather
 * than owned by `SplitFrame` alone.
 */
function Sidebar({
  views,
  folded,
  onToggleFold,
}: {
  views: readonly SlotEntry<'sidebar.views'>[]
  folded: boolean
  onToggleFold(): void
}) {
  // The column's own state (view choice) is below; its **width** belongs to the
  // frame that lays it out (see `SplitFrame`).
  // The store's version is the snapshot: the chosen id itself is read separately,
  // so the snapshot is a number and never a fresh object (React #185).
  // The third argument (the server snapshot) is the same number: the shell
  // server-renders the page first, and React requires one to do it.
  useSyncExternalStore(viewChoice.subscribe, viewVersion, viewVersion)
  // Shortcut hints (contract.md §3.7, v0.15). Both are read **before** the
  // early return below: a hook after a conditional return changes the hook
  // count between renders and takes the whole subtree down with it
  // (docs/m15/spec.md §6 trap 1).
  const { ctx } = useKernel()
  const commands = ctx.commands as CommandsService | undefined
  const held = useHeldModifier()
  useSyncExternalStore(
    useCallback((listener: () => void) => commands?.subscribe(listener) ?? (() => {}), [commands]),
    useCallback(() => commands?.version ?? 0, [commands]),
    useCallback(() => commands?.version ?? 0, [commands]),
  )
  // Publish the store as the page's layout face once this column exists: pieces
  // in other halves read it (never import it — each half is its own build).
  useLayoutEffect(publishViewChoice, [])
  const chosen = viewChoice.get()
  const keys = views.map(view => view.key ?? '')
  viewChoice.register(keys)
  // `active` drives the views' `props.active`; it is computed on every render
  // from the store, so a command's change reaches the views in the same pass.
  const active = chosen !== undefined && keys.includes(chosen) ? chosen : (keys.includes(DEFAULT_VIEW) ? DEFAULT_VIEW : keys[0])
  /**
   * An icon of the switcher, pressed (contract.md §5.2, v0.13). The gesture is
   * the activity bar's: **the icon that is already showing folds the column**,
   * any other icon switches to its view and unfolds — that is what the reader
   * means by "click the left-hand icon" when the column is in the way, and a
   * folded column only has its icons to offer, so pressing one there has to
   * unfold rather than change a pane nobody can see.
   */
  const setChosen = (view: string): void => {
    if (folded) {
      viewChoice.show(view)
      foldChoice.set(false)
      return
    }
    if (view === active) {
      foldChoice.set(true)
      return
    }
    viewChoice.show(view)
  }
  if (views.length === 0) return null
  return (
    <aside
      className={`diorama-layout__sidebar${folded ? ' diorama-layout__sidebar--folded' : ''}`}
      data-slot="sidebar.views"
      data-folded={folded ? 'true' : 'false'}
      // While a modifier is held the rail lets its chips out of the 36px
      // column (see the stylesheet): they are drawn beside the icon, not in it.
      data-hints={held === undefined ? undefined : 'true'}
    >
      <div className="diorama-sidebar__rail">
        <ViewSwitcher
          views={views}
          active={active}
          folded={folded}
          held={held}
          hintOf={view => hintOfCommand(commands, SIDEBAR_COMMANDS.find(command => command.key === view)?.id)}
          onPick={setChosen}
        />
        <FoldButton folded={folded} onToggle={onToggleFold} />
      </div>
      {/* Folded panes are hidden, not unmounted — the same rule as an inactive
          view, so unfolding comes back to the same scroll and expansion
          (contract.md §5.2). */}
      <div
        className="diorama-sidebar__panes"
        id="diorama-sidebar-panes"
        data-testid="sidebar-panes"
        style={folded ? { display: 'none' } : undefined}
      >
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
  // Folding is a preference too, and it belongs to the frame for the same
  // reason: the frame is what gives the column its width (contract.md §5.2).
  useSyncExternalStore(foldChoice.subscribe, foldVersion, foldVersion)
  const folded = foldChoice.get()
  const frame = useRef<HTMLDivElement | null>(null)
  // While the pointer is down only the CSS variable moves (see `splitpane`):
  // re-rendering the column on every frame would re-render the whole tree.
  const preview = (next: number): void => {
    frame.current?.style.setProperty('--dio-sidebar-width', `${next}px`)
  }
  const toggleFold = useCallback(() => foldChoice.toggle(), [])
  if (views.length > 0) {
    return (
      <div
        ref={frame}
        className={`diorama-layout diorama-layout--split${folded ? ' diorama-layout--folded' : ''}`}
        data-layout="split"
        data-folded={folded ? 'true' : 'false'}
        style={{ '--dio-sidebar-width': `${width}px`, '--dio-sidebar-rail': `${SIDEBAR_RAIL_PX}px` } as CSSProperties}
      >
        <Sidebar views={views} folded={folded} onToggleFold={toggleFold} />
        {/* A folded column has no edge to drag: its width is the switcher's.
            The edge is unmounted rather than hidden, so it cannot take focus
            or a drag that would set a width nobody can see. */}
        {folded ? null : (
          <Splitter
            side="start"
            size={width}
            onPreview={preview}
            onCommit={setWidth}
            label="调整侧栏宽度"
            testId="sidebar-splitter"
          />
        )}
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
      run: () => {
        viewChoice.show(command.key)
        // Same rule as the switcher: showing a view shows the column.
        foldChoice.set(false)
      },
    })
    commands.bind({ keys: command.keys, command: command.id })
  }
  // Folding the column (contract.md §3.7, v0.13). A command like the view
  // switches above — the palette lists it, and `mod+b` is its key — and it is
  // only executable while there is a column at all.
  commands.register({
    id: SIDEBAR_FOLD_COMMAND,
    title: '侧栏：收起 / 展开',
    when: () => viewChoice.any(),
    run: () => {
      foldChoice.toggle()
    },
  })
  commands.bind({ keys: 'mod+b', command: SIDEBAR_FOLD_COMMAND })
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
      // The URL says which view, not whether the column is folded: a reader who
      // folded it and refreshed gets the view back **inside** a folded column
      // (the fold is a preference of its own, contract.md §5.2).
      return
    }
  }
}

/**
 * The registry's hint for one command, or `undefined` when the page has no
 * registry (the server half) or the command has no binding. Reading it must
 * never break the frame: a page without `ctx.commands` simply shows no chips.
 */
function hintOfCommand(commands: CommandsService | undefined, id: string | undefined): { label: string; keys: string } | undefined {
  if (commands === undefined || id === undefined) return undefined
  try {
    const binding = commands.bindingFor(id)
    return binding === undefined ? undefined : { label: binding.label, keys: binding.keys }
  } catch {
    return undefined
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
