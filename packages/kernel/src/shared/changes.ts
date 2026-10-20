/**
 * Fold the flat rows of `ctx.git.status()` into a directory tree for the
 * changes view (contract.md §3.2). Pure and React-free: the service stays flat
 * (one row per path, git's own order) and the view gets what it draws.
 *
 * Two rules keep the tree readable when a repository has thousands of changes:
 *
 * - **Directory order**: directories first, then files; within each, names by
 *   the same locale-aware comparison the file tree uses.
 * - **Single-child dirs are folded** into one row (`src/app/routes` instead of
 *   three nested levels), unless `fold` is false — a repository with one deep
 *   chain otherwise spends the whole column on indentation.
 *
 * An empty input is an empty tree; the root itself is returned (with
 * `count` = number of changed files) so the caller can decide whether to draw
 * a header at all.
 */
import type { ChangeTreeNode, GitStatusEntry } from './types.ts'

/** Directories first, then names (locale-aware, case-insensitive, stable). */
export function compareChangeNodes(a: ChangeTreeNode, b: ChangeTreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
}

export interface ChangeTreeOptions {
  /** Fold single-child directory chains into one row (default `true`). */
  fold?: boolean
}

/** Build the changed-file tree from flat status entries. */
export function buildChangeTree(entries: readonly GitStatusEntry[], options: ChangeTreeOptions = {}): ChangeTreeNode {
  const root: ChangeTreeNode = { kind: 'dir', path: '', name: '', count: 0, children: [] }
  const dirs = new Map<string, ChangeTreeNode>([['', root]])
  const dirOf = (path: string): ChangeTreeNode => {
    const slash = path.lastIndexOf('/')
    const dirPath = slash === -1 ? '' : path.slice(0, slash)
    const existing = dirs.get(dirPath)
    if (existing !== undefined) return existing
    // Create the missing ancestors first (the entry's path decides its place).
    const parent = dirOf(dirPath)
    const node: ChangeTreeNode = {
      kind: 'dir',
      path: dirPath,
      name: dirPath.slice(dirPath.lastIndexOf('/') + 1),
      count: 0,
      children: [],
    }
    parent.children?.push(node)
    dirs.set(dirPath, node)
    return node
  }
  for (const entry of entries) {
    const parent = dirOf(entry.file)
    const name = entry.file.slice(entry.file.lastIndexOf('/') + 1)
    parent.children?.push({ kind: 'file', path: entry.file, name, count: 1, entry })
  }
  const count = (node: ChangeTreeNode): number => {
    if (node.kind === 'file') return 1
    let total = 0
    for (const child of node.children ?? []) total += count(child)
    node.count = total
    return total
  }
  count(root)
  const sort = (node: ChangeTreeNode): void => {
    node.children?.sort(compareChangeNodes)
    for (const child of node.children ?? []) sort(child)
  }
  sort(root)
  if (options.fold !== false) foldSingleChildDirs(root)
  return root
}

/**
 * Merge a directory that has exactly one child directory into it: the child
 * takes the parent's place with a joined path (`src` + `app` → `src/app`).
 * The child must itself be a directory; a lone *file* child stays separate, so
 * the row keeps saying "this is a directory with one changed file".
 */
function foldSingleChildDirs(node: ChangeTreeNode): void {
  for (const child of node.children ?? []) foldSingleChildDirs(child)
  const children = node.children ?? []
  for (let index = 0; index < children.length; index++) {
    const child = children[index]
    if (child === undefined || child.kind !== 'dir') continue
    let current = child
    while (current.children?.length === 1 && current.children[0]?.kind === 'dir') {
      const only = current.children[0]
      if (only === undefined) break
      current = {
        kind: 'dir',
        path: only.path,
        name: `${current.name}/${only.name}`,
        count: 0,
        children: only.children,
      }
    }
    if (current !== child) children[index] = current
  }
}

/** Every directory path of a tree, depth first (the default expanded set). */
export function directoryPaths(node: ChangeTreeNode): string[] {
  const out: string[] = []
  for (const child of node.children ?? []) {
    if (child.kind !== 'dir') continue
    out.push(child.path)
    out.push(...directoryPaths(child))
  }
  return out
}
