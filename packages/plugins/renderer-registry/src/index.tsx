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
import { useCallback, useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react'
import { mimeOf } from 'diorama-kernel'
import type { FileInfo, FileRendererProps, MountHandle, TabInfo } from 'diorama-kernel'
import type {} from 'diorama-plugin-slots'
import type { RendererCandidate, RendererChoice, SlotEntry } from 'diorama-plugin-slots'
import { chooseRenderer, PROBE_HEAD_BYTES, probeHead } from 'diorama-plugin-slots'
import { describeError, EntryBoundary, provideEntry, useKernel } from 'diorama-ui'

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
  | { status: 'loading' }
  | { status: 'ready'; props: FileRendererProps }
  | { status: 'error'; error: string }

interface CacheEntry {
  stamp: string
  state: Loaded
}

const CACHE = new WeakMap<MountHandle, FileCache>()

const LOADING: Loaded = { status: 'loading' }

/**
 * Per-mount file cache keyed by path and refreshed when size or mtime moves.
 * Reads happen here — the one place a file's content enters the renderer tree.
 *
 * `snapshot` is pure: it never starts IO (a store read runs during React's
 * render/commit, and IO started there re-enters the store until the tree
 * thrashes). `ensure` is the effect-side call that starts the read.
 */
class FileCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly loads = new Map<string, Promise<void>>()
  private readonly listeners = new Set<() => void>()

  snapshot(file: FileInfo): Loaded {
    const entry = this.entries.get(file.path)
    if (entry === undefined || entry.stamp !== `${file.size}:${file.mtime}`) return LOADING
    return entry.state
  }

  /** Start loading `file` unless it is loaded or loading already. */
  ensure(mount: MountHandle, file: FileInfo): void {
    const stamp = `${file.size}:${file.mtime}`
    const entry = this.entries.get(file.path)
    if (entry !== undefined && entry.stamp === stamp) return
    if (this.loads.has(file.path)) return
    const load = this.load(mount, file, stamp).finally(() => {
      this.loads.delete(file.path)
    })
    this.loads.set(file.path, load)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async load(mount: MountHandle, file: FileInfo, stamp: string): Promise<void> {
    let state: Loaded
    try {
      const mime = mimeOf(file.path)
      const text = await mount.fs.readText(file.path)
      state = { status: 'ready', props: { file, text, mime } }
    } catch (error) {
      if ((error as { code?: string }).code !== 'EBINARY') {
        state = { status: 'error', error: describeError(error) }
      } else {
        try {
          const mime = mimeOf(file.path)
          const bytes = await mount.fs.readBytes(file.path)
          state = { status: 'ready', props: { file, bytes, mime } }
        } catch (inner) {
          state = { status: 'error', error: describeError(inner) }
        }
      }
    }
    this.entries.set(file.path, { stamp, state })
    for (const listener of [...this.listeners]) listener()
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
  const cache = useMemo(() => cacheFor(mount), [mount])
  // The snapshot is pure (`cache.snapshot`); the read itself starts in an
  // effect. A store whose reads start IO re-enters React's render/commit pass
  // and thrashes the page once a file takes a frame to arrive.
  const { file } = tab
  const snapshot = useCallback(() => cache.snapshot(file), [cache, file])
  const loaded = useSyncExternalStore(cache.subscribe, snapshot)
  // `file` is a fresh object per click: depend on its identity, not the object.
  const stamp = `${file.path}:${file.size}:${file.mtime}`
  const ensure = useEffectEvent(() => cache.ensure(mount, file))
  useEffect(() => {
    ensure()
  }, [stamp])

  // Renderers live in one seat across keys (each under its own plugin id), so
  // read every entry of `file.renderer` and let the chooser order them.
  const registry = kernel.registry
  // A new registration changes the registry's version, not its identity; a
  // failure mark is a separate, page-versioned change.
  const seatVersion = registry?.version ?? 0
  const seat = useMemo(
    () => (registry === undefined ? [] : (registry.all() as readonly SlotEntry[]).filter(entry => entry.name === 'file.renderer')),
    [registry, seatVersion],
  )
  const usable = seat.filter(entry => !views.failed(entry.id))
  const entries = usable
  const mime = mimeOf(file.path)
  const ready = loaded.status === 'ready'
  const readyProps = ready ? loaded.props : undefined

  // The chooser runs in an effect (probes may need IO), but its inputs are
  // compared by content: `loadedProps`, the seat list and `file` are rebuilt
  // every render, and re-running it per render would `setChoice` for ever.
  const loadedKey = readyProps === undefined ? '' : `${readyProps.file.path}:${readyProps.file.size}:${readyProps.file.mtime}:${readyProps.text === undefined ? 'bytes' : 'text'}`
  const seatKey = seat.map(entry => entry.id).join(',')
  const choiceKey = `${loadedKey}|${seatKey}|${mime}`
  const [choice, setChoice] = useState<{ key: string; value: Chosen | 'unresolved' } | undefined>(undefined)
  const choose = useEffectEvent(() => {
    const head = async (path: string): Promise<Uint8Array> => {
      if (readyProps?.bytes !== undefined) return probeHead(readyProps.bytes, PROBE_HEAD_BYTES)
      try {
        return probeHead(await mount.fs.readBytes(path), PROBE_HEAD_BYTES)
      } catch {
        return new Uint8Array()
      }
    }
    return chooseRenderer(candidatesOf(usable), { file, mime }, { head })
  })

  useEffect(() => {
    if (!ready) return
    let live = true
    void choose().then(
      next => {
        if (!live) return
        setChoice({ key: choiceKey, value: next.kind === 'match' || next.kind === 'fallback' ? next : 'unresolved' })
      },
      (error: unknown) => {
        console.error('[diorama] renderer-registry: choosing a renderer failed', error)
        if (live) setChoice({ key: choiceKey, value: 'unresolved' })
      },
    )
    return () => {
      live = false
    }
  }, [ready, choiceKey])

  const chosen = choice !== undefined && choice.key === choiceKey ? choice.value : undefined

  if (loaded.status === 'loading') {
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
  if (chosen === undefined) {
    return <div className="diorama-renderer" data-testid="renderer-loading" />
  }
  if (chosen === 'unresolved') {
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

  const entry = entries.find(item => item.id === chosen.id)
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
