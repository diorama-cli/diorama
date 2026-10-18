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

function seatKey(name: string, key: string | undefined): string {
  return key === undefined ? name : `${name}\u0000${key}`
}

/**
 * A registered entry plus the bookkeeping the registry needs to honour its
 * declaration. Entries are stored per seat (one list per `(name, key)`).
 */
interface StoredEntry extends SlotEntry {
  declarations: Partial<Record<SlotName, SlotSpec>>
  parentSeat: string | undefined
}

export interface SlotRegistryOptions {
  /** Sink for loud warnings (conflicts, undeclared seats). Defaults to console.warn. */
  warn?: (message: string) => void
}

export class SlotRegistry {
  private readonly entries = new Map<string, StoredEntry>()
  private readonly specs = new Map<string, SlotSpec>()
  private readonly declaredBy = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private order: SlotOrder = defaultSlotOrder
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
   * `keyed` requires `key`, `list` never rejects on count. A skipped
   * registration (conflict or undeclared seat) returns a no-op disposer and is
   * reported through `warn` — first registration wins, nothing is replaced.
   */
  register<K extends SlotName>(registration: SlotRegistration<K>, component: SlotComponent<K>): () => void {
    const { id, name } = registration
    if (typeof id !== 'string' || id === '') throw new TypeError('slots.register: "id" must be a non-empty string')
    if (this.entries.has(id)) {
      this.warn(`duplicate id "${id}" (slot "${name}") refused; the first registration wins`)
      return () => {}
    }
    const spec = this.specs.get(name)
    if (spec === undefined) {
      this.warn(`"${id}" registered into undeclared slot "${name}"; no owner draws it, so it is not mounted`)
      return () => {}
    }
    const seat = seatKey(name, registration.key)
    const siblings = [...this.entries.values()].filter(entry => seatKey(entry.name, entry.key) === seat)
    if (spec.kind === 'single' && siblings.length > 0) {
      this.warn(
        `single slot "${name}" already has an occupant "${siblings[0]?.id}"; "${id}" refused`,
      )
      return () => {}
    }
    if (spec.kind === 'keyed' && registration.key === undefined) {
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
    const entry: StoredEntry = {
      id,
      name,
      key: registration.key,
      order: registration.order ?? 100,
      component: component as SlotComponent,
      declarations: registration.declare ?? {},
      parentSeat: undefined,
    }
    for (const [child, childSpec] of Object.entries(entry.declarations)) {
      if (childSpec === undefined) continue
      this.specs.set(child, childSpec)
      this.declaredBy.set(child, id)
    }
    this.entries.set(id, entry)
    this.notify()
    return () => this.disposeEntry(id)
  }

  /**
   * Entries of one seat, in total order. The returned array is stable between
   * notifications, so it is safe to hand to `useSyncExternalStore`.
   */
  entriesOf<K extends SlotName>(name: K, key?: string): readonly SlotEntry<K>[] {
    return (this.sorted.get(seatKey(name, key)) ?? []) as unknown as readonly SlotEntry<K>[]
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
    for (const child of Object.keys(entry.declarations)) {
      if (this.declaredBy.get(child) !== id) continue
      this.declaredBy.delete(child)
      this.specs.delete(child)
    }
    this.notify()
  }

  private notify(): void {
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
