/**
 * Slot registry core: the only component registration model (contract.md §5,
 * architecture.md §4). This is pure state — no React, no Cordis — so the client
 * plugin half, tests, and the renderer can all share one implementation.
 *
 * Declaration rule (M0, following DSH): **declaring is claiming.** A parent
 * entry names the child seats its component renders (`declare`), and becomes
 * the only entry allowed to render them. Registering into a seat nobody
 * declared fails loud — that is what stops a piece from silently drawing into
 * a seat its owner does not draw.
 *
 * Conflict rules (contract.md §3.3, v0.2 — three kinds, three answers):
 * - a duplicate `id` **throws**: it is a programming error;
 * - a second entry in a `single` seat, a keyed entry without `key`, an
 *   undeclared seat, or a second declaration of a child seat is refused with a
 *   warning (first wins);
 * - several entries in the same `(name, key)` **coexist** as an ordered
 *   fallback chain; an equal `order` is kept and broken by `id`, with a warning.
 */
import {
  BUILTIN_SLOTS,
  type SlotComponent,
  type SlotEntry,
  type SlotKind,
  type SlotName,
  type SlotRegistration,
  type SlotSpec,
} from './types.ts'

export type SlotOrder = (a: SlotEntry, b: SlotEntry) => number

/** Default total order: ascending `order`, ties broken by `id`. */
export const defaultSlotOrder: SlotOrder = (a, b) => a.order - b.order || a.id.localeCompare(b.id)

/** Fails loud on a duplicate registration id (contract.md §3.3). */
export class SlotConflictError extends Error {
  constructor(readonly id: string) {
    super(`slots.register: id "${id}" is already registered (ids are global; prefix with the plugin id)`)
    this.name = 'SlotConflictError'
  }
}

function seatKey(name: string, key: string | undefined): string {
  return key === undefined ? name : `${name}\u0000${key}`
}

/**
 * A registered entry plus the bookkeeping the registry needs to honour its
 * declaration. Entries are stored per seat (one list per `(name, key)`).
 */
interface StoredEntry extends SlotEntry {
  declarations: Partial<Record<SlotName, SlotSpec>>
}

export interface SlotRegistryOptions {
  /** Sink for loud warnings (conflicts, undeclared seats). Defaults to console.warn. */
  warn?: (message: string) => void
}

/** A registration waiting for the entry that declares its seat. */
interface DeferredEntry {
  registration: SlotRegistration
  component: SlotComponent
}

export class SlotRegistry {
  private readonly entries = new Map<string, StoredEntry>()
  private readonly specs = new Map<string, SlotSpec>()
  private readonly declaredBy = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private readonly pending: DeferredEntry[] = []
  private order: SlotOrder = defaultSlotOrder
  private revision = 0
  private sorted = new Map<string, readonly SlotEntry[]>()

  constructor(private readonly options: SlotRegistryOptions = {}) {
    for (const [name, spec] of Object.entries(BUILTIN_SLOTS)) {
      if (spec !== undefined) this.specs.set(name, spec)
    }
  }

  /** Install the total order used to sort every seat. */
  useOrder(order: SlotOrder): void {
    this.order = order
    this.notify()
  }

  /**
   * Register one entry; returns its disposer.
   *
   * Kind is enforced from the declared seat: `single` allows one occupant,
   * `keyed` requires `key`, `list` never rejects on count. A duplicate `id`
   * throws ({@link SlotConflictError}); every other refusal returns a no-op
   * disposer and is reported through `warn` — nothing is replaced silently.
   */
  register<K extends SlotName>(registration: SlotRegistration<K>, component: SlotComponent<K>): () => void {
    const pending = this.pending.findIndex(item => item.registration.id === registration.id)
    if (pending !== -1) this.pending.splice(pending, 1)
    const { id, name } = registration
    if (typeof id !== 'string' || id === '') throw new TypeError('slots.register: "id" must be a non-empty string')
    // Late cancellations (an unmounted entry whose seat was declared in the
    // meantime) resolve only after the registration has been recorded.
    this.resolvePending()
    if (this.entries.has(id)) throw new SlotConflictError(id)
    const spec = this.specs.get(name)
    if (spec === undefined) {
      // Boot order is not registration order: a renderer may register before
      // the piece that declares the seat it draws into. Hold the entry until
      // the declaration arrives; once the seat is never declared (no pending
      // pieces can declare it) it stays unmounted and was never warned about.
      this.pending.push({ registration: registration as SlotRegistration, component: component as SlotComponent })
      return () => {
        const index = this.pending.findIndex(item => item.registration.id === id)
        if (index === -1) return
        this.pending.splice(index, 1)
      }
    }
    const seat = seatKey(name, registration.key)
    const siblings = [...this.entries.values()].filter(entry => seatKey(entry.name, entry.key) === seat)
    if (spec.kind === 'single' && siblings.length > 0) {
      this.warn(`single slot "${name}" already has an occupant "${siblings[0]?.id}"; "${id}" refused`)
      return () => {}
    }
    if (spec.kind === 'keyed' && (registration.key === undefined || registration.key === '')) {
      this.warn(`keyed slot "${name}" requires a key; "${id}" refused`)
      return () => {}
    }
    for (const child of Object.keys(registration.declare ?? {})) {
      const owner = this.declaredBy.get(child)
      if (owner !== undefined) {
        this.warn(`slot "${child}" is already declared by "${owner}"; "${id}" cannot declare it too`)
        return () => {}
      }
    }
    if ((registration.matcher as { cost?: unknown } | undefined)?.cost !== undefined) {
      const cost = (registration.matcher as { cost?: unknown }).cost
      if (cost !== 'cheap' && cost !== 'expensive') {
        this.warn(`"${id}" declares probe cost "${String(cost)}"; expected "cheap" or "expensive"`)
        return () => {}
      }
    }
    const order = registration.order ?? 100
    const entry: StoredEntry = {
      id,
      name,
      key: registration.key,
      order,
      component: component as SlotComponent,
      ...(registration.matcher === undefined ? {} : { matcher: registration.matcher }),
      declarations: registration.declare ?? {},
    }
    // Equal order across the entries of one seat, whatever their keys: the
    // dispatcher sorts them together by `id` (contract.md §3.3).
    const sameSeat = [...this.entries.values()].filter(entry => entry.name === name)
    if (sameSeat.some(sibling => sibling.order === order)) {
      this.warn(`slot "${name}" has several entries with order ${order}; ties break by id`)
    }
    for (const [child, childSpec] of Object.entries(entry.declarations)) {
      if (childSpec === undefined) continue
      this.specs.set(child, childSpec)
      this.declaredBy.set(child, id)
    }
    this.entries.set(id, entry)
    this.resolvePending()
    this.notify()
    return () => this.disposeEntry(id)
  }

  /**
   * Retry registrations that were waiting for their seat's declaration. A
   * `declare` is only retried when its parent entry actually rendered it, so
   * this happens at most once per newly declared seat and cannot loop.
   */
  private resolvePending(): void {
    let progressed = true
    while (progressed) {
      progressed = false
      for (let index = 0; index < this.pending.length; index++) {
        const pending = this.pending[index] as DeferredEntry
        if (this.specs.get(pending.registration.name) === undefined) continue
        this.pending.splice(index, 1)
        index--
        progressed = true
        try {
          this.register(pending.registration, pending.component)
        } catch (error) {
          this.warn(`deferred entry "${pending.registration.id}" failed to register: ${(error as Error).message}`)
        }
      }
    }
  }

  /**
   * Declare seats up front (contract.md §3.3). An already-declared seat is left
   * alone — `declare` is a statement of intent, not an ownership grab.
   */
  declare(seats: Partial<Record<SlotName, SlotSpec>>): void {
    let changed = false
    for (const [name, spec] of Object.entries(seats)) {
      if (spec === undefined || this.specs.has(name)) continue
      this.specs.set(name, spec)
      changed = true
    }
    if (!changed) return
    this.resolvePending()
    this.notify()
  }

  /**
   * Entries of one seat, in total order. The returned array is stable between
   * notifications, so it is safe to hand to `useSyncExternalStore`.
   */
  entriesOf<K extends SlotName>(name: K, key?: string): readonly SlotEntry<K>[] {
    return (this.sorted.get(seatKey(name, key)) ?? []) as unknown as readonly SlotEntry<K>[]
  }

  /** Changes on every registration or removal (memoisation key). */
  get version(): number {
    return this.revision
  }

  /** Every registered entry, in registration order (fallback-chain planning). */
  all(): readonly SlotEntry[] {
    return [...this.entries.values()].sort(this.order)
  }

  /** The declaration of a seat, if any. */
  specOf(name: SlotName): SlotSpec | undefined {
    return this.specs.get(name)
  }

  /** Which entry declared a seat. */
  ownerOf(name: SlotName): string | undefined {
    return this.declaredBy.get(name)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Entries still waiting for their seat's declaration (diagnostics). */
  waiting(): string[] {
    return this.pending.map(item => item.registration.id)
  }

  /** The declared seats and their kinds (diagnostics). */
  declarations(): Record<string, SlotSpec> {
    return Object.fromEntries(this.specs)
  }

  /** Registered ids, in registration order (diagnostics). */
  ids(): string[] {
    return [...this.entries.keys()]
  }

  private warn(message: string): void {
    ;(this.options.warn ?? (text => console.warn(`[diorama] ${text}`)))(message)
  }

  private disposeEntry(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    this.entries.delete(id)
    // Seats this entry declared lose their declaration with it; entries that
    // were waiting on those seats are now permanently undeclared.
    for (const child of Object.keys(entry.declarations)) {
      if (this.declaredBy.get(child) !== id) continue
      this.declaredBy.delete(child)
      this.specs.delete(child)
    }
    this.notify()
  }

  private notify(): void {
    this.revision++
    const next = new Map<string, SlotEntry[]>()
    for (const entry of this.entries.values()) {
      const seat = seatKey(entry.name, entry.key)
      const bucket = next.get(seat)
      const publicEntry: SlotEntry = {
        id: entry.id,
        name: entry.name,
        order: entry.order,
        component: entry.component,
        ...(entry.key === undefined ? {} : { key: entry.key }),
        ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
      }
      if (bucket === undefined) next.set(seat, [publicEntry])
      else bucket.push(publicEntry)
    }
    for (const bucket of next.values()) bucket.sort(this.order)
    this.sorted = next
    for (const listener of this.listeners) listener()
  }
}

export type { SlotKind }
