/**
 * file-tree — the left navigation column.
 *
 * Provides `ctx.tree` and is the only client piece that lists directories: it
 * calls `mountCtx.fs.list` lazily as directories are expanded and hands the
 * chosen file to `ctx.tabs` through `ctx.tree`. Removing this piece removes
 * the column entirely; the layout must not depend on it (M0 acceptance
 * point 3).
 */
import type { Context } from 'cordis'
import { useEffect, useState } from 'react'
import type { FileInfo, MountHandle } from 'diorama-kernel/client'
import { createTreeService } from 'diorama-kernel/client'
import { bindMethods, provideEntry, useKernel, useStore } from 'diorama-ui'

export const name = 'file-tree'
export const inject = ['slots']

interface DirState {
  entries?: FileInfo[]
  error?: string
}

/** Directories first, then names (locale-aware, case-insensitive, stable). */
function compareEntries(a: FileInfo, b: FileInfo): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
}

function useDirectory(mount: MountHandle, path: string, open: boolean): DirState {
  const [state, setState] = useState<DirState>({})
  useEffect(() => {
    if (!open) return
    let cancelled = false
    mount.fs.list(path).then(
      entries => {
        if (!cancelled) setState({ entries: [...entries].sort(compareEntries) })
      },
      (error: unknown) => {
        if (!cancelled) setState({ error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [mount, path, open])
  return state
}

function TreeRow({ mountCtx, file, depth }: { mountCtx: MountHandle; file: FileInfo; depth: number }) {
  const { ctx } = useKernel()
  const tree = ctx.tree
  const snapshot = useStore(tree)
  const isDir = file.kind === 'dir'
  const expanded = isDir && snapshot.expanded.includes(file.path)
  const selected = !isDir && snapshot.selected === file.path
  const dirState = useDirectory(mountCtx, file.path, expanded)

  return (
    <>
      <button
        type="button"
        className={`diorama-tree__row${selected ? ' diorama-tree__row--selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-path={file.path}
        data-kind={file.kind}
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected}
        title={file.path}
        onClick={() => (isDir ? tree.toggle(file.path) : tree.select(file))}
      >
        <span className="diorama-tree__caret" aria-hidden="true">
          {isDir ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="diorama-tree__name">{file.name}</span>
      </button>
      {expanded && dirState.error !== undefined && (
        <div className="diorama-tree__error" style={{ paddingLeft: 22 + depth * 14 }}>
          {dirState.error}
        </div>
      )}
      {expanded &&
        dirState.entries?.map(child => (
          <TreeRow key={child.path} mountCtx={mountCtx} file={child} depth={depth + 1} />
        ))}
    </>
  )
}

function FileTreeRoot() {
  const { ctx, mount: mountCtx } = useKernel()
  const rootEntries = useDirectory(mountCtx, '', true)
  // Selecting a file opens it: the tab service is the only opener. `ctx` here is
  // the page's kernel context (installed before pieces render), so it carries
  // the live services.
  useEffect(() => ctx.tree.onSelect(file => ctx.tabs.open(file)), [ctx])
  return (
    <nav className="diorama-tree" aria-label="文件树" data-testid="file-tree">
      {rootEntries.error !== undefined && <div className="diorama-tree__error">{rootEntries.error}</div>}
      {rootEntries.entries?.map(file => (
        <TreeRow key={file.path} mountCtx={mountCtx} file={file} depth={0} />
      ))}
    </nav>
  )
}

export function apply(ctx: Context) {
  // See `tabs`: the service face comes from the kernel so every build agrees.
  // Bind: this half runs its own build of the service class (see `tabs`).
  ctx.provide('tree', bindMethods(createTreeService()))
  provideEntry(ctx, { id: 'file-tree:nav', name: 'sidebar.tree', order: 100 }, FileTreeRoot)
}
