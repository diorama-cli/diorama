/**
 * `ctx.tabs` (client): open, switch and close tabs — never edit
 * (contract.md §3.4).
 *
 * Multi-tab since v0.3: one tab per **file path** (`open` on an open file
 * activates it instead of opening a second tab). A tab holds the path only —
 * not a `FileInfo` snapshot — so the content seat re-reads the file itself
 * (which is also what lets a file change refresh its content later).
 *
 * Tabs holds no file data: it cannot depend on `fs` or on `tabs.content`'s
 * renderer. Opening a file is navigation; the renderer-registry reads what it
 * needs through `mountCtx.fs`.
 */
import type { FileInfo, TabInfo } from '../shared/types.ts'

declare module 'cordis' {
  interface Context {
    /** Open / switch tabs. Provided by the `tabs` plugin. */
    tabs: TabsService
  }
}

/** Snapshot of the tab state; immutable, replaced on every change. */
export interface TabsSnapshot {
  tabs: readonly TabInfo[]
  activeId: string | undefined
}

const EMPTY: TabsSnapshot = { tabs: [], activeId: undefined }

export class TabsService {
  private store: TabsSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private counter = 0

  /**
   * Open a file, or activate its tab when it is already open. No-op for
   * directories. Returns the tab that is now active.
   */
  open(file: FileInfo): TabInfo {
    if (file.kind !== 'file') {
      const active = this.active
      if (active !== undefined) return active
      throw new TypeError('ctx.tabs.open: nothing to activate for a non-file')
    }
    const existing = this.store.tabs.find(tab => tab.path === file.path)
    if (existing !== undefined) {
      if (this.store.activeId !== existing.id) this.publish({ ...this.store, activeId: existing.id })
      return existing
    }
    const tab: TabInfo = { id: `tab-${++this.counter}`, path: file.path }
    this.publish({ tabs: [...this.store.tabs, tab], activeId: tab.id })
    return tab
  }

  /**
   * Close one tab (default: the active one). The right neighbour becomes
   * active, else the left, else nothing (contract.md §3.4).
   */
  close(id?: string): void {
    const target = id ?? this.store.activeId
    if (target === undefined) return
    const index = this.store.tabs.findIndex(tab => tab.id === target)
    if (index === -1) return
    const tabs = this.store.tabs.filter(tab => tab.id !== target)
    if (tabs.length === 0) {
      this.publish(EMPTY)
      return
    }
    if (this.store.activeId !== target) {
      this.publish({ tabs, activeId: this.store.activeId })
      return
    }
    const next = tabs[Math.min(index, tabs.length - 1)]
    this.publish({ tabs, activeId: next?.id })
  }

  /** Make a tab active; unknown ids are ignored (the snapshot is unchanged). */
  activate(id: string): void {
    if (this.store.activeId === id) return
    if (!this.store.tabs.some(tab => tab.id === id)) return
    this.publish({ ...this.store, activeId: id })
  }

  /** Activate the next tab, wrapping around. */
  next(): void {
    this.step(1)
  }

  /** Activate the previous tab, wrapping around. */
  prev(): void {
    this.step(-1)
  }

  /** The active tab, if any. */
  get active(): TabInfo | undefined {
    const { tabs, activeId } = this.store
    return tabs.find(tab => tab.id === activeId)
  }

  /** Number of open tabs (command `when` predicates use it). */
  get count(): number {
    return this.store.tabs.length
  }

  /** Immutable snapshot, stable between changes (for useSyncExternalStore). */
  getSnapshot = (): TabsSnapshot => this.store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Move `delta` tabs from the active one, wrapping (no-op when empty). */
  private step(delta: 1 | -1): void {
    const { tabs, activeId } = this.store
    if (tabs.length < 2) return
    const index = tabs.findIndex(tab => tab.id === activeId)
    const from = index === -1 ? (delta === 1 ? -1 : 0) : index
    const target = tabs[(from + delta + tabs.length) % tabs.length]
    if (target !== undefined) this.publish({ ...this.store, activeId: target.id })
  }

  private publish(next: TabsSnapshot): void {
    this.store = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** The `ctx.tabs` face as a plain object (pieces provide it; identity is not class-bound). */
export function createTabsService(): TabsService {
  return new TabsService()
}
