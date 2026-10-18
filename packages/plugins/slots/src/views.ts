/**
 * `ctx.views`: read-only slot observation for components (docs/m0/spec.md §3.2).
 *
 * Contract §5 has no "slot is empty" or "entry failed" concept, yet the M0
 * acceptance points require both ("无可用渲染器", "只剩右侧空白"). Views is the
 * minimal additive face that lets a component see a seat without owning its
 * registration. Read-only: registration is `ctx.slots`.
 *
 * A failed entry is recorded here by the component that rendered it, so a
 * dispatcher can skip it and try the next one (contract §5 fallback chain).
 */
import type { SlotRegistry } from './registry.ts'
import type { SlotEntry, SlotName } from './types.ts'

export interface FailureInfo {
  error: unknown
  /** Milliseconds since epoch. */
  at: number
}

export interface ViewsService {
  /** Subscribe to any slot registry change. */
  subscribe(listener: () => void): () => void
  /** Entries of one seat, in order (stable array between notifications). */
  entries<K extends SlotName>(name: K, key?: string): readonly SlotEntry<K>[]
  /** Entries of one seat minus entries currently marked failed. */
  usable<K extends SlotName>(name: K, key?: string): readonly SlotEntry<K>[]
  /** Whether an entry is marked failed. */
  failed(id: string): boolean
  /** Why an entry failed, if it is marked failed. */
  failure(id: string): FailureInfo | undefined
  /** Mark an entry as failed (keeps the first reason until cleared). */
  reportFailure(id: string, error: unknown): void
  /** Clear a failure mark. */
  clearFailure(id: string): void
  /** Subscribe to failure-state changes of one entry. */
  onFailure(id: string, listener: (info: FailureInfo | undefined) => void): () => void
}

export function createViews(registry: SlotRegistry): ViewsService {
  const failures = new Map<string, FailureInfo>()
  const perEntry = new Map<string, Set<(info: FailureInfo | undefined) => void>>()

  const emit = (id: string): void => {
    const listeners = perEntry.get(id)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener(failures.get(id))
  }

  return {
    subscribe: listener => registry.subscribe(listener),
    entries: (name, key) => registry.entriesOf(name, key),
    usable: (name, key) => registry.entriesOf(name, key).filter(entry => !failures.has(entry.id)),
    failed: id => failures.has(id),
    failure: id => failures.get(id),
    reportFailure(id, error) {
      if (failures.has(id)) return
      failures.set(id, { error, at: Date.now() })
      emit(id)
    },
    clearFailure(id) {
      if (!failures.delete(id)) return
      emit(id)
    },
    onFailure(id, listener) {
      const listeners = perEntry.get(id) ?? new Set()
      listeners.add(listener)
      perEntry.set(id, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) perEntry.delete(id)
      }
    },
  }
}
