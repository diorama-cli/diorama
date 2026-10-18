/**
 * renderer-registry — dispatch of `file.renderer` (contract.md §5, §5.1).
 *
 * Registers into `tabs.content`, declares the `file.renderer` seat it owns, and
 * dispatches: reads the active file once, asks `chooseRenderer` which entry
 * claims it (`ext` → `mime` → `probe`, then the fallback), and renders that
 * entry. An entry that throws is marked failed through `ctx.views` and the next
 * candidate is tried; when nothing can render, the seat says so instead of
 * blanking (M0 acceptance point 2, kept in M1).
 *
 * Renderers never do IO: the file's text (or bytes, for binary content) is read
 * here, once, and handed down as props (contract.md §5.1).
 */
import type { Context } from 'cordis'
import { useEffect, useState, type ComponentType } from 'react'
import { mimeOf } from 'diorama-kernel'
import type { FileInfo, FileRendererProps, MountHandle, TabInfo } from 'diorama-kernel'
import type {} from 'diorama-plugin-slots'
import type { RendererCandidate, RendererChoice, SlotEntry } from 'diorama-plugin-slots'
import { chooseRenderer, PROBE_HEAD_BYTES, probeHead } from 'diorama-plugin-slots'
import { describeError, EntryBoundary, provideEntry, useKernel, useStore } from 'diorama-ui'

export type { FileRendererProps } from './types.ts'

export const name = 'renderer-registry'
export const inject = ['slots']

/** The seat this piece owns and renders (contract.md §5). */
const DECLARE = {
  'file.renderer': { kind: 'keyed' },
} as const

/** Props of the `tabs.content` entry. */
export interface RegistryContentProps {
  tab: TabInfo
}

type Loaded =
  | { status: 'ready'; props: FileRendererProps }
  | { status: 'error'; error: string }

interface CacheEntry {
  stamp: string
  state: Loaded | undefined
  /** The in-flight read, so several components do not fetch the same file. */
  pending?: Promise<void>
  error?: string
}

const CACHE = new WeakMap<MountHandle, FileCache>()

/**
 * Per-mount file cache keyed by path and refreshed when size or mtime moves.
 * Reads happen here — the one place a file's content enters the renderer tree.
 */
class FileCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly listeners = new Set<() => void>()

  /** Current state, or `undefined` while loading (the caller shows a spinner). */
  read(mount: MountHandle, file: FileInfo): Loaded | undefined {
    const stamp = `${file.size}:${file.mtime}`
    let entry = this.entries.get(file.path)
    if (entry === undefined || entry.stamp !== stamp) {
      entry = { stamp, state: undefined }
      this.entries.set(file.path, entry)
      void this.load(mount, file, entry)
    }
    if (entry.pending !== undefined) return undefined
    return entry.error === undefined ? entry.state : { status: 'error', error: entry.error }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async load(mount: MountHandle, file: FileInfo, entry: CacheEntry): Promise<void> {
    entry.pending = (async () => {
      const mime = mimeOf(file.path)
      try {
        const text = await mount.fs.readText(file.path)
        entry.state = { status: 'ready', props: { file, text, mime } }
      } catch (error) {
        if ((error as { code?: string }).code !== 'EBINARY') throw error
        const bytes = await mount.fs.readBytes(file.path)
        entry.state = { status: 'ready', props: { file, bytes, mime } }
      }
    })()
    try {
      await entry.pending
    } catch (error) {
      entry.error = describeError(error)
    } finally {
      entry.pending = undefined
      for (const listener of [...this.listeners]) listener()
    }
  }
}

function cacheFor(mount: MountHandle): FileCache {
  let cache = CACHE.get(mount)
  if (cache === undefined) {
    cache = new FileCache()
    CACHE.set(mount, cache)
  }
  return cache
}

/** Turn seat entries into what the chooser needs, keeping entry objects for rendering. */
function candidatesOf(entries: readonly SlotEntry[]): RendererCandidate[] {
  return entries.map(entry => ({
    id: entry.id,
    order: entry.order,
    ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
  }))
}

type Chosen = Extract<RendererChoice, { kind: 'match' | 'fallback' }>

function RegistryContent({ tab }: RegistryContentProps) {
  const kernel = useKernel()
  const { mount, views } = kernel
  const cache = cacheFor(mount)
  const loaded = useStore({
    subscribe: cache.subscribe,
    getSnapshot: () => cache.read(mount, tab.file),
  })

  // Read the seat on every page version: a failed entry must leave the chain,
  // and a newly registered renderer must be considered for the open file.
  // The seat has no sub-key: `entriesOf` is keyed by `(name, {file}.path)` only
  // for keyed seats, and `file.renderer` is one shared seat.
  // One seat, many entries: renderers register under their own key (their
  // plugin id), so the seat is read across keys and ordered by the chooser.
  const registry = kernel.registry
  const entries = (registry === undefined
    ? []
    : (registry.all() as readonly SlotEntry[]).filter(entry => entry.name === 'file.renderer'))
  const usable = entries.filter(entry => !views.failed(entry.id))
  const { file } = tab
  const mime = mimeOf(file.path)
  const [choice, setChoice] = useState<Chosen | 'unresolved' | undefined>(undefined)

  useEffect(() => {
    if (loaded === undefined) return
    let live = true
    const head = loaded.status === 'ready'
      ? async (path: string): Promise<Uint8Array> => {
          if (loaded.props.bytes !== undefined) return probeHead(loaded.props.bytes, PROBE_HEAD_BYTES)
          try {
            return probeHead(await mount.fs.readBytes(path), PROBE_HEAD_BYTES)
          } catch {
            return new Uint8Array()
          }
        }
      : undefined
    chooseRenderer(candidatesOf(usable), { file, mime }, head === undefined ? {} : { head }).then(
      next => {
        if (live) setChoice(next.kind === 'match' || next.kind === 'fallback' ? next : 'unresolved')
      },
      (error: unknown) => {
        console.error('[diorama] renderer-registry: choosing a renderer failed', error)
        if (live) setChoice('unresolved')
      },
    )
    return () => {
      live = false
    }
  }, [loaded, file, mime, mount, entries])

  if (loaded === undefined) {
    return (
      <div className="diorama-renderer" data-testid="renderer-loading">
        正在读取 {file.name}…
      </div>
    )
  }
  if (loaded.status === 'error') {
    return (
      <div className="diorama-renderer diorama-renderer__error" role="alert" data-testid="renderer-read-error">
        {loaded.error}
      </div>
    )
  }
  if (choice === undefined) {
    return <div className="diorama-renderer" data-testid="renderer-loading" />
  }
  if (choice === 'unresolved') {
    if (entries.length === 0) {
      return (
        <div className="diorama-renderer__empty" role="status" data-testid="renderer-empty">
          无可用渲染器
        </div>
      )
    }
    if (usable.length === 0) {
      const errors = entries.map(entry => describeError(views.failure(entry.id)?.error))
      return (
        <div className="diorama-renderer__error" role="alert" data-testid="renderer-failed">
          渲染失败：{errors.join('；')}
        </div>
      )
    }
    return (
      <div className="diorama-renderer__empty" role="status" data-testid="renderer-empty">
        无可派发的渲染器
      </div>
    )
  }

  const entry = entries.find(item => item.id === choice.id)
  const Renderer = entry?.component as unknown as ComponentType<FileRendererProps> | undefined
  if (entry === undefined || Renderer === undefined) return null
  return (
    <div className="diorama-renderer" data-testid="renderer" data-renderer={entry.id}>
      <EntryBoundary
        key={`${entry.id}:${loaded.props.file.path}`}
        onError={error => views.reportFailure(entry.id, error)}
        fallback={
          <div className="diorama-renderer__error" role="alert" data-testid="renderer-entry-failed">
            渲染器 {entry.id} 出错，已跳过
          </div>
        }
      >
        <Renderer {...loaded.props} />
      </EntryBoundary>
    </div>
  )
}

export function apply(ctx: Context) {
  // Declare the seat this piece owns before anything registers into it: the
  // renderers draw here without owning it (contract.md §3.3).
  // (`tabs.content` is declared by `tabs`; declaring it here too would be a
  // second owner and the dispatch entry would be refused.)
  const slots = ctx.slots
  slots.declare(DECLARE)
  provideEntry(
    ctx,
    { id: 'renderer-registry:dispatch', name: 'tabs.content', order: 100, declare: DECLARE },
    RegistryContent,
  )
}
