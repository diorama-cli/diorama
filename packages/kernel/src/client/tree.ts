/**
 * `ctx.tree` (client): navigation state of the left column
 * (docs/m0/spec.md §3.4). `file-tree` owns it — it is also the only client
 * plugin allowed to list directories (`mountCtx.fs`) — and hands selected
 * files to whoever subscribed.
 *
 * The service is renderer-agnostic: it stores an immutable snapshot of which
 * directories are expanded, which file is selected, and which one is to be
 * brought into view. `tabs` listens for `onSelect`; the tree UI renders from
 * `getSnapshot`.
 */
import type { FileInfo } from '../shared/types.ts'

declare module 'cordis' {
  interface Context {
    /** Navigation state of the tree column. Provided by the `file-tree` plugin. */
    tree: TreeService
  }
}

/**
 * A request to bring one path into view: every ancestor expanded, the row
 * scrolled to. A **stamp** rather than a path, because asking twice for the
 * same path is two requests ("定位" pressed again must work), and a snapshot
 * that merely repeats a path would not notify anybody (contract.md §35).
 */
export interface TreeReveal {
  path: string
  /** Monotonic; a new request is always a new number. */
  at: number
}

/** Immutable tree state. */
export interface TreeSnapshot {
  /** Relative paths of expanded directories. */
  expanded: readonly string[]
  /** The selected file, if any. */
  selected: string | undefined
  /** The last "bring this into view" request, if any. */
  reveal: TreeReveal | undefined
}

const EMPTY: TreeSnapshot = { expanded: [], selected: undefined, reveal: undefined }

/** Every directory between the mount root and `path` (`a/b/c.md` → `a`, `a/b`). */
export function ancestorsOf(path: string): string[] {
  const segments = path.split('/').filter(segment => segment !== '')
  const out: string[] = []
  for (let index = 1; index < segments.length; index++) out.push(segments.slice(0, index).join('/'))
  return out
}

export class TreeService {
  private store: TreeSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private readonly selectListeners = new Set<(file: FileInfo) => void>()
  private reveals = 0

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
    // Always hand the click to the opener, even when the node is already the
    // selection: with tabs, clicking a file that is open in a *background* tab
    // must activate that tab, and the tree has no say in which tab is active.
    if (this.store.selected !== file.path) this.publish({ ...this.store, selected: file.path })
    for (const listener of [...this.selectListeners]) listener(file)
  }

  /**
   * Ask the tree to bring `path` into view (contract.md §35): expand every
   * directory on the way to it, then let the view scroll its row into the
   * middle of the pane. It does **not** select the file and does not open
   * anything — locating where the reader already is is not a navigation.
   *
   * The ancestors are expanded here rather than by the view: "which
   * directories are open" is this service's state, and a request that only
   * named the file would leave the row inside a collapsed parent.
   */
  reveal(path: string): void {
    const expanded = [...this.store.expanded]
    for (const ancestor of ancestorsOf(path)) {
      if (!expanded.includes(ancestor)) expanded.push(ancestor)
    }
    this.publish({ ...this.store, expanded, reveal: { path, at: ++this.reveals } })
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
