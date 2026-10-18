/**
 * `ctx.tree` (client): navigation state of the left column
 * (docs/m0/spec.md §3.4). `file-tree` owns it — it is also the only client
 * plugin allowed to list directories (`mountCtx.fs`) — and hands selected
 * files to whoever subscribed.
 *
 * The service is renderer-agnostic: it stores an immutable snapshot of which
 * directories are expanded and which file is selected. `tabs` listens for
 * `onSelect`; the tree UI renders from `getSnapshot`.
 */
import type { FileInfo } from '../shared/types.ts'

declare module 'cordis' {
  interface Context {
    /** Navigation state of the tree column. Provided by the `file-tree` plugin. */
    tree: TreeService
  }
}

/** Immutable tree state. */
export interface TreeSnapshot {
  /** Relative paths of expanded directories. */
  expanded: readonly string[]
  /** The selected file, if any. */
  selected: string | undefined
}

const EMPTY: TreeSnapshot = { expanded: [], selected: undefined }

export class TreeService {
  private store: TreeSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private readonly selectListeners = new Set<(file: FileInfo) => void>()

  /** Subscribe to navigation events; returns the unsubscriber. */
  onSelect(listener: (file: FileInfo) => void): () => void {
    this.selectListeners.add(listener)
    return () => {
      this.selectListeners.delete(listener)
    }
  }

  /** Select a file: updates the snapshot and notifies subscribers. */
  select(file: FileInfo): void {
    if (file.kind !== 'file') return
    if (this.store.selected === file.path) return
    this.publish({ ...this.store, selected: file.path })
    for (const listener of [...this.selectListeners]) listener(file)
  }

  /** Expand or collapse a directory. */
  toggle(path: string): void {
    const expanded = this.store.expanded
    this.publish({
      ...this.store,
      expanded: expanded.includes(path) ? expanded.filter(other => other !== path) : [...expanded, path],
    })
  }

  /** Whether a directory is expanded. */
  isExpanded(path: string): boolean {
    return this.store.expanded.includes(path)
  }

  /** Immutable snapshot, stable between changes (for useSyncExternalStore). */
  getSnapshot = (): TreeSnapshot => this.store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(next: TreeSnapshot): void {
    this.store = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** The `ctx.tree` face as a plain object (pieces provide it; identity is not class-bound). */
export function createTreeService(): TreeService {
  return new TreeService()
}
