/**
 * `ctx.tabs` (client): open and switch, never edit (contract.md §3.4).
 *
 * M0 has single-tab semantics: `open(file)` replaces the active tab in place,
 * so a tab keeps its identity across file switches (M2 turns this into a real
 * multi-tab registry behind the same service face).
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

export class TabsService {
  /** M0: one tab, fixed identity. */
  static readonly SINGLE_TAB_ID = 'tab-1'

  private store: TabsSnapshot = { tabs: [], activeId: undefined }
  private readonly listeners = new Set<() => void>()

  /** Open a file; M0 replaces the single tab's file. No-op for directories. */
  open(file: FileInfo): void {
    if (file.kind !== 'file') return
    const current = this.store.tabs[0]
    const tab: TabInfo = { id: current?.id ?? TabsService.SINGLE_TAB_ID, file }
    this.publish({ tabs: [tab], activeId: tab.id })
  }

  /** Close one tab (M0: closing the only tab empties the area). */
  close(id: string = TabsService.SINGLE_TAB_ID): void {
    if (this.store.activeId !== id) return
    this.publish({ tabs: [], activeId: undefined })
  }

  /** The active tab, if any. */
  get active(): TabInfo | undefined {
    const { tabs, activeId } = this.store
    return tabs.find(tab => tab.id === activeId)
  }

  /** Immutable snapshot, stable between changes (for useSyncExternalStore). */
  getSnapshot = (): TabsSnapshot => this.store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
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
