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
import { useState, type ReactElement } from 'react'
import { provideEntry, Slot, useKeyedSeat } from 'diorama-ui'
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
  // The overlay seat (contract.md §5): the palette and other command surfaces
  // draw here, above the frame and outside it.
  'layout.overlay': { kind: 'single' },
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
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const keys = views.map(view => view.key ?? '')
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
  if (views.length > 0) {
    return (
      <div className="diorama-layout diorama-layout--split" data-layout="split">
        <Sidebar views={views} />
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

/** Whatever occupies `layout.overlay` (a palette, …); absent = nothing. */
function Overlay() {
  return (
    <Slot
      name="layout.overlay"
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
}
