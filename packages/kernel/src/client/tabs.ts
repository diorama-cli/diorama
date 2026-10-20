/**
 * `ctx.tabs` (client): open, switch and close tabs — never edit
 * (contract.md §3.4).
 *
 * One tab per **(file, view)** since v0.5: opening `src/app.js` in content view
 * and again in diff view gives two tabs that can sit side by side; opening the
 * same file in the same view activates the existing tab instead of adding one.
 * A tab holds the path and its view only — not a `FileInfo` snapshot — so the
 * content seat re-reads the file itself (which is also what lets a file change
 * refresh its content later).
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

/**
 * How a tab shows its file (contract.md §3.4): `content` is the file itself,
 * `diff` is the working tree's change to it. A tab carries the mode, not the
 * file data: the content seat (or the renderer the tab routes to) reads it.
 */
export type TabView = 'content' | 'diff'

const EMPTY: TabsSnapshot = { tabs: [], activeId: undefined }

export class TabsService {
  private store: TabsSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private counter = 0
  /**
   * How many times `open()` was asked for a file (contract.md §3.4). It counts
   * **asks**, not changes: reopening the file that is already active changes
   * nothing in the snapshot, yet it is the reader choosing that file — a piece
   * showing something other than a tab (a picked commit) watches this to know
   * the reader went back to browsing. Nothing else in the service depends on it.
   */
  private opens = 0

  /**
   * Open a file in a view, or activate its tab when one with the same
   * `(path, view)` is already open. No-op for directories. Returns the tab
   * that is now active (contract.md §3.4).
   */
  open(file: FileInfo, options: { view?: TabView } = {}): TabInfo {
    const view: TabView = options.view ?? 'content'
    if (file.kind !== 'file') {
      const active = this.active
      if (active !== undefined) return active
      throw new TypeError('ctx.tabs.open: nothing to activate for a non-file')
    }
    // Every ask is counted, and announced even when it changes no tab: opening
    // the file that is already active is still the reader choosing that file
    // (see `openCount`). One notification per call, whichever branch below runs.
    this.opens++
    const existing = this.store.tabs.find(tab => tab.path === file.path && (tab.view ?? 'content') === view)
    if (existing !== undefined) {
      if (this.store.activeId !== existing.id) this.publish({ ...this.store, activeId: existing.id })
      else this.notify()
      return existing
    }
    const tab: TabInfo = { id: `tab-${++this.counter}`, path: file.path, ...(view === 'content' ? {} : { view }) }
    this.publish({ tabs: [...this.store.tabs, tab], activeId: tab.id })
    return tab
  }

  /** How a tab shows its file (default `content`). */
  viewOf(id: string): TabView {
    return this.store.tabs.find(tab => tab.id === id)?.view ?? 'content'
  }

  /** The open tab of `(path, view)`, if any (the tab's key, contract.md §3.4). */
  find(path: string, view: TabView = 'content'): TabInfo | undefined {
    return this.store.tabs.find(tab => tab.path === path && (tab.view ?? 'content') === view)
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

  /** Opens asked for so far (a monotonic count; see `open`). */
  get openCount(): number {
    return this.opens
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
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** The `ctx.tabs` face as a plain object (pieces provide it; identity is not class-bound). */
export function createTabsService(): TabsService {
  return new TabsService()
}
