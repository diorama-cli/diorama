/**
 * file-tree — the left navigation column.
 *
 * Provides `ctx.tree` and is the only client piece that lists directories: it
 * calls `mountCtx.fs.list` lazily as directories are expanded and hands the
 * chosen file to `ctx.tabs` through `ctx.tree`. Removing this piece removes
 * the column entirely; the layout must not depend on it (M0 acceptance point
 * 3).
 *
 * Hiding is **not** done here: `fs.list` already omits every entry the
 * `ignore` rules hide (contract.md §3.1, §4.1), so the tree, any future file
 * search and the server agree by construction.
 *
 * Large directories: a directory with many entries lists its first
 * `PAGE_SIZE` and offers 「加载更多」. This is not the `ignore` rule (those
 * entries are gone); it only keeps rendering bounded.
 */
import type { Context } from 'cordis'
import { useCallback, useEffect, useState } from 'react'
import type { FileInfo, MountHandle } from 'diorama-kernel/client'
import { createTreeService, type CommandsService } from 'diorama-kernel/client'
import { bindMethods, FileIcon, Icon, iconSvg, provideEntry, useKernel, useStore } from 'diorama-ui'

export const name = 'file-tree'
export const inject = ['slots']

/** Entries a collapsed-until-asked directory shows at first (M2). */
export const PAGE_SIZE = 500

/**
 * The switcher icon (contract.md §5.2; `layout` draws it verbatim). Built from
 * the page's button table (docs/m7/spec.md §3), so the activity bar is one
 * family of glyphs; `iconSvg` answers `''` in a page with no table, and the
 * switcher then falls back to the title's first character as it always has.
 */
export const FILES_ICON = iconSvg('files')

interface DirState {
  entries?: FileInfo[]
  error?: string
}

/** Directories first, then names (locale-aware, case-insensitive, stable). */
function compareEntries(a: FileInfo, b: FileInfo): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
}

/**
 * One directory's entries, fetched when it is first drawn. `limit` starts at
 * `PAGE_SIZE` and only grows; the full (already filtered) list is kept so
 * 「加载更多」 does not re-list.
 */
function useDirectory(mount: MountHandle, path: string, open: boolean): DirState & { visible: number; more(batch?: number): void } {
  const [state, setState] = useState<DirState>({})
  const [visible, setVisible] = useState(PAGE_SIZE)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let reload = (): void => {}
    const load = (): void => {
      mount.fs.list(path).then(
        entries => {
          if (!cancelled) setState({ entries: [...entries].sort(compareEntries) })
        },
        (error: unknown) => {
          if (!cancelled) setState({ error: error instanceof Error ? error.message : String(error) })
        },
      )
    }
    load()
    // A change in this directory re-lists it: create / delete / rename all
    // change the entry set, and `change` may be the first event of a file that
    // was just created (the kind is only a hint, contract.md §3.1, U2).
    reload = mount.fs.watch(path, () => load())
    // A reconnect is not a directory event (contract.md §4): anything created or
    // deleted while the page was offline was never reported, so list once more.
    const stopReconnect = mount.rpc.onReconnect(() => {
      if (!cancelled) load()
    })
    return () => {
      cancelled = true
      stopReconnect()
      reload()
    }
  }, [mount, path, open])
  const more = useCallback((batch = PAGE_SIZE) => setVisible(current => current + batch), [])
  return { ...state, visible, more }
}

function TreeRow({ mountCtx, file, depth }: { mountCtx: MountHandle; file: FileInfo; depth: number }) {
  const { ctx } = useKernel()
  const tree = ctx.tree
  const snapshot = useStore(tree)
  const isDir = file.kind === 'dir'
  const expanded = isDir && snapshot.expanded.includes(file.path)
  const selected = !isDir && snapshot.selected === file.path
  const dirState = useDirectory(mountCtx, file.path, expanded)
  const total = dirState.entries?.length ?? 0
  const cut = Math.min(dirState.visible, total)

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
          {isDir ? <Icon name={expanded ? 'caret-down' : 'caret-right'} size={14} /> : null}
        </span>
        <FileIcon name={file.name} kind={file.kind} expanded={expanded} />
        <span className="diorama-tree__name">{file.name}</span>
      </button>
      {expanded && dirState.error !== undefined && (
        <div className="diorama-tree__error" style={{ paddingLeft: 22 + depth * 14 }}>
          {dirState.error}
        </div>
      )}
      {expanded &&
        dirState.entries?.slice(0, cut).map(child => (
          <TreeRow key={child.path} mountCtx={mountCtx} file={child} depth={depth + 1} />
        ))}
      {expanded && cut < total && (
        <button
          type="button"
          className="diorama-tree__more"
          style={{ paddingLeft: 8 + (depth + 1) * 14 }}
          data-path={file.path}
          data-testid="tree-more"
          onClick={() => dirState.more()}
        >
          <Icon name="caret-down" size={14} />
          加载更多（已显示 {cut} / 共 {total} 条）
        </button>
      )}
    </>
  )
}

function FileTreeRoot({ active = true }: { active?: boolean }) {
  const { ctx, mount: mountCtx } = useKernel()
  const rootEntries = useDirectory(mountCtx, '', true)
  const total = rootEntries.entries?.length ?? 0
  const cut = Math.min(rootEntries.visible, total)
  // Selecting a file opens it: the tab service is the only opener. `ctx` here is
  // the page's kernel context (installed before pieces render), so it carries
  // the live services.
  useEffect(() => ctx.tree.onSelect(file => ctx.tabs.open(file)), [ctx])
  // The view stays mounted while inactive (contract.md §5.2); `aria-hidden`
  // keeps a hidden pane out of the accessibility tree and its buttons untabbable.
  return (
    <nav className="diorama-tree" aria-label="文件树" data-testid="file-tree" aria-hidden={active ? undefined : true}>
      {rootEntries.error !== undefined && <div className="diorama-tree__error">{rootEntries.error}</div>}
      {rootEntries.entries?.slice(0, cut).map(file => (
        <TreeRow key={file.path} mountCtx={mountCtx} file={file} depth={0} />
      ))}
      {cut < total && (
        <button type="button" className="diorama-tree__more" data-testid="tree-more" onClick={() => rootEntries.more()}>
          <Icon name="caret-down" size={14} />
          加载更多（已显示 {cut} / 共 {total} 条）
        </button>
      )}
    </nav>
  )
}

export function apply(ctx: Context) {
  // See `tabs`: the service face comes from the kernel so every build agrees.
  // Bind: this half runs its own build of the service class (see `tabs`).
  ctx.provide('tree', bindMethods(createTreeService()))
  // The tree is one view of the left column (contract.md §5.2), not the column.
  provideEntry(
    ctx,
    { id: 'file-tree:nav', name: 'sidebar.views', key: 'files', order: 10, title: '文件', icon: FILES_ICON },
    FileTreeRoot,
  )

  // `tree.focus` (contract.md §3.7): the tree owns the command that moves
  // focus into it, and the tree is where focus lands.
  // `commands` is kernel *client* infrastructure (contract.md §3.7). The same
  // module is also loaded as this piece's server half, where it does not exist,
  // so it is read opportunistically and the server half stops here.
  const commands = clientCommands(ctx)
  if (commands === undefined) return
  commands.register({
    id: 'tree.focus',
    title: '聚焦文件树',
    when: context => context.focus !== 'tree',
    // (With nothing focused — `other` — focusing the tree is still useful.)
    run: () => {
      const first = document.querySelector<HTMLElement>('[data-testid="file-tree"] [data-path]')
      first?.focus()
    },
  })
  commands.bind({ keys: 'mod+alt+f', command: 'tree.focus' })
}

/**
 * `ctx.commands` when this context is a page (client kernel), else `undefined`.
 * One module serves both halves, and Cordis throws on reading a service that is
 * neither provided nor injected — so the server half asks instead of assuming.
 */
function clientCommands(ctx: Context): CommandsService | undefined {
  try {
    return (ctx as unknown as { commands?: CommandsService }).commands
  } catch {
    return undefined
  }
}
