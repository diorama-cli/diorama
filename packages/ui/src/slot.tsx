/**
 * Slot rendering primitives for the browser.
 *
 * A slot is a named seat. The renderer never touches the slot registry
 * directly; it reads the entries through `ctx.views` and renders them inside
 * error boundaries so a failing entry degrades the page instead of blanking it
 * (architecture.md §7).
 *
 * Page state travels through **one page-global bridge**. The bridge is created
 * and installed by the shell; every client half carries its own build of this
 * module, so state must never be reached through module imports — always
 * through `globalThis` (see `pageBridge()`).
 */
import {
  Component,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react'
import type { Context } from 'cordis'
import type { MountHandle } from 'diorama-kernel'
import type { SlotEntry, SlotName } from 'diorama-plugin-slots'

/** What components need from the page: services plus the mount handle. */
export interface KernelContextValue {
  /** Read-only view of any seat's entries (not only the ones a component owns). */
  registry?: {
    entriesOf(name: string, key?: string): readonly unknown[]
    all(): readonly unknown[]
  }
  /** Read-only slot observation (entries, failures). */
  views: {
    subscribe(listener: () => void): () => void
    entries(name: never, key?: string): readonly unknown[]
    failed(id: string): boolean
    failure(id: string): { error: unknown } | undefined
    reportFailure(id: string, error: unknown): void
  }
  /** The page's Cordis context, for services other pieces provide. */
  ctx: Context
  /** The page handle (`mountCtx`). */
  mount: MountHandle
}

/** The single page bridge (installed by the shell). */
interface PageBridge {
  /** The page kernel, once the shell installed it. */
  getKernel(): KernelContextValue | undefined
  /** Snapshot version; changes on every page-state change. */
  getVersion(): number
  /** Subscribe to page-state changes. */
  subscribe(listener: () => void): () => void
}

/**
 * Read the page bridge from the page global. The key is a literal on purpose:
 * the shell and the halves are separate builds of this module, and only the
 * global is shared between them.
 */
function pageBridge(): PageBridge {
  const scope = globalThis as unknown as { __diorama_page__?: PageBridge }
  const current = scope.__diorama_page__
  if (current === undefined) throw new Error('diorama renderer: no page is booted')
  return current
}

/** Whether a page bridge exists yet (safe during module evaluation). */
export function isPageBooted(): boolean {
  return (globalThis as unknown as { __diorama_page__?: PageBridge }).__diorama_page__ !== undefined
}

/**
 * Entries of one seat, re-read on every page-state change. Unlike `Slot`, this
 * does not render: a component that *declares* a seat uses it to inspect what
 * others registered there (e.g. the renderer dispatcher).
 */
export function useSeat(name: string, key?: string): readonly unknown[] {
  usePageVersion()
  return pageBridge().getKernel()?.registry?.entriesOf(name, key) ?? []
}

/** The page kernel, re-reading on every page-state change. */
export function useKernel(): KernelContextValue {
  usePageVersion()
  const kernel = pageBridge().getKernel()
  if (kernel === undefined) throw new Error('diorama renderer: the page kernel is not installed')
  return kernel
}

/**
 * Re-render on every page-state change. Returns the version the render is based
 * on (depend on it in `useMemo` when deriving from page state).
 */
export function usePageVersion(): number {
  return useSyncExternalStore(subscribeKernel, kernelVersion, kernelVersion)
}

/** Snapshot for `useSyncExternalStore`: stable between notifications. */
export function kernelVersion(): number {
  return pageBridge().getVersion()
}

/** Subscribe to page-state changes (re-render on any seat change). */
export function subscribeKernel(listener: () => void): () => void {
  // Call the bridge's own `subscribe`, *through* the bridge: React may invoke
  // this detached (no receiver), so the bridge must be closed over by name.
  return pageBridge().subscribe(listener)
}

/**
 * A React-free store: what `useSyncExternalStore` needs. Accepts the store
 * object (whose methods stay bound at the call site) rather than detached
 * functions, so a piece can pass its own service.
 */
export interface Store<T> {
  subscribe(listener: () => void): () => void
  getSnapshot(): T
}

/**
 * Subscribe to a piece-owned store and re-read it on every page change. The
 * snapshot is recomputed per read, so a store rebuilt each render still yields
 * current data.
 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(
    listener => {
      const offPage = subscribeKernel(listener)
      const offStore = store.subscribe(listener)
      return () => {
        offPage()
        offStore()
      }
    },
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  )
}

/**
 * A seat snapshot that is stable between page-version bumps: the same object is
 * returned until the bridge version changes, which is what
 * `useSyncExternalStore` requires (a fresh array on every read re-renders
 * forever).
 */
interface SeatSnapshot {
  version: number
  entries: readonly unknown[]
}

const SEAT_CACHE = new WeakMap<object, Map<string, SeatSnapshot>>()

function seatSnapshot(name: string, key: string | undefined): SeatSnapshot {
  const bridge = pageBridge()
  const version = bridge.getVersion()
  const views = bridge.getKernel()?.views
  if (views === undefined) return { version, entries: [] }
  let seats = SEAT_CACHE.get(views)
  if (seats === undefined) {
    seats = new Map()
    SEAT_CACHE.set(views, seats)
  }
  const seat = key === undefined ? name : `${name}\u0000${key}`
  const cached = seats.get(seat)
  if (cached !== undefined && cached.version === version) return cached
  const next: SeatSnapshot = { version, entries: views.entries(name as never, key) }
  seats.set(seat, next)
  return next
}

/**
 * Bind every own function of a service object to itself.
 *
 * Client halves are separate builds: a consumer in another build receives the
 * service through Cordis and may call its methods detached from the object
 * (`const open = ctx.tabs.open`). Binding at provision time makes the service
 * behave the same in every build (docs/m0/spec.md §11.3 rule 3).
 */
export function bindMethods<T extends object>(service: T): T {
  for (const key of Object.keys(service) as (keyof T)[]) {
    const value = service[key] as unknown
    if (typeof value !== 'function') continue
    ;(service as Record<keyof T, unknown>)[key] = (value as (...args: never[]) => unknown).bind(service)
  }
  return service
}

/** The `ctx.slots` face as a half sees it (structural: no Cordis import here). */
interface SlotsFace {
  register(registration: unknown, component: unknown): () => void
}

/**
 * Register one slot entry.
 *
 * Always call through the service object (`ctx.slots`), never through a class
 * method that may have arrived detached: each client half carries its own build
 * of the registry, and a lost `this` would register into another registry —
 * silently (docs/m0/spec.md §11.3, contract.md §8).
 */
export function provideEntry<T>(ctx: { slots: SlotsFace }, registration: T, component: unknown): () => void {
  const slots = ctx.slots
  return slots.register(registration, component)
}

/** Format an unknown throwable for display. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface BoundaryProps {
  /** Called once per caught error (reported to `views` by the caller). */
  onError?: (error: unknown) => void
  fallback?: ReactNode
  children: ReactNode
}

interface BoundaryState {
  error?: unknown
}

/**
 * React error boundary. Error boundaries are the one React API that still
 * requires a class, so this is the renderer's only class component.
 */
export class EntryBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = {}

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error }
  }

  override componentDidCatch(error: unknown): void {
    console.error('[diorama] slot entry failed:', error, (error as Error)?.stack?.split('\n').slice(1, 4).join(' | '))
    this.props.onError?.(error)
  }

  override render(): ReactNode {
    if ('error' in this.state) return this.props.fallback ?? null
    return this.props.children
  }
}

/** Render one entry, isolated by its own boundary. */
export function SlotEntryView({
  entry,
  props,
  fallback,
}: {
  entry: SlotEntry
  props?: object
  fallback?: ReactNode
}) {
  const EntryComponent = entry.component as unknown as ComponentType<object>
  return (
    <EntryBoundary onError={error => pageBridge().getKernel()?.views.reportFailure(entry.id, error)} fallback={fallback}>
      {/* One spread of the same object: an inline `{...props}` literal would be
          a fresh prop set on every render and remount the entry continuously. */}
      <EntryComponent {...(props ?? {})} />
    </EntryBoundary>
  )
}

/**
 * Content of a seat's `empty` state. Pass a **component type** when the
 * fallback renders anything stateful: an element literal is a new node on every
 * render and remounts its subtree (React update-depth loops).
 */
export type EmptySeat = ComponentType<object> | ReactNode

export interface SlotPropsSeat<K extends SlotName = SlotName> {
  readonly name: K
  readonly slotKey?: string
  /** Props handed to every rendered entry (the seat's data). */
  readonly props?: object
  /** Shown when the seat has no entries at all (element or component type). */
  readonly empty?: EmptySeat
  /** Shown when entries exist but every one of them failed. */
  readonly exhausted?: (errors: string[]) => ReactNode
  /** Wraps one entry instead of rendering it directly. */
  readonly render?: (entry: SlotEntry<K>) => ReactNode
  /** Render every usable entry (a list seat) instead of only the first. */
  readonly list?: boolean
  readonly fallback?: ReactNode
}

/**
 * Render the entries of one seat.
 *
 * - `render` is called with each usable entry; the caller supplies data props.
 * - `empty` is shown when the seat has no entries at all.
 * - `exhausted` is shown when entries exist but all were marked failed.
 * - A single seat renders the first usable entry; `list` renders all of them.
 */
export function Slot<K extends SlotName>({
  name,
  slotKey,
  props,
  empty = null,
  exhausted,
  render,
  list = false,
  fallback = null,
}: SlotPropsSeat<K>) {
  // One subscription through the page bridge, over a snapshot that is stable
  // between version bumps (a fresh array on every read would re-render forever).
  const snapshot = useSyncExternalStore(
    subscribeKernel,
    () => seatSnapshot(name, slotKey),
    () => seatSnapshot(name, slotKey),
  )
  const views = pageBridge().getKernel()?.views
  if (views === undefined) throw new Error('diorama renderer: the page kernel is not installed')
  const entries = snapshot.entries as readonly SlotEntry<K>[]
  const usable = entries.filter(entry => !views.failed(entry.id))

  if (entries.length === 0) {
    // A component type mounts once; an element literal is a new node every render.
    const Empty = empty as ComponentType<object>
    return typeof empty === 'function' ? <Empty /> : <>{empty as ReactNode}</>
  }
  if (usable.length === 0) {
    const errors = entries.map(entry => describeError(views.failure(entry.id)?.error))
    return <>{exhausted?.(errors) ?? fallback}</>
  }

  const chosen = list ? usable : usable.slice(0, 1)
  // A single seat renders its entrance directly, so a `render` callback that
  // builds the whole frame (like layout's) is not wrapped in a boundary per
  // pass. Failures still surface through the entry's own error path.
  if (render !== undefined) {
    const content = chosen.map(entry => (
      <EntryBoundary
        key={entry.id}
        onError={error => views.reportFailure(entry.id, error)}
        fallback={fallback}
      >
        {render(entry)}
      </EntryBoundary>
    ))
    return <>{content}</>
  }
  return (
    <>
      {chosen.map(entry => (
        <SlotEntryView
          key={entry.id}
          entry={entry as unknown as SlotEntry}
          props={props}
          fallback={fallback}
        />
      ))}
    </>
  )
}
