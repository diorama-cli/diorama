/**
 * renderer-registry — dispatch of `file.renderer` (contract.md §5, §5.1).
 *
 * Registers into each `tabs.content` seat (one per tab), declares the
 * `file.renderer` seat it owns, and dispatches: reads the tab's file once
 * (stat, then text — or bytes for binary content), asks `chooseRenderer` which
 * entry claims it (`ext` → `mime` → `probe`, then the fallback), and renders
 * that entry. An entry that throws is marked failed through `ctx.views` and the
 * next candidate is tried; when nothing can render, the seat says so instead of
 * blanking (M0 acceptance point 2, kept in M1).
 *
 * Renderers never do IO: the file's text (or bytes) is read here, once, and
 * handed down as props (contract.md §5.1). The tab carries a path only
 * (contract.md §3.4), so this is also where a change is noticed: a watched
 * `change`/`unlink` or a `view.refresh` command makes the next pass re-stat.
 */
import type { Context } from 'cordis'
import { useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react'
import { mimeOf } from 'diorama-kernel'
import type { FileInfo, FileRendererProps, MountHandle, TabInfo } from 'diorama-kernel'
import type {} from 'diorama-plugin-slots'
import type { RendererCandidate, RendererChoice, SlotEntry } from 'diorama-plugin-slots'
import { chooseRenderer, PROBE_HEAD_BYTES, probeHead } from 'diorama-plugin-slots'
import { describeError, EntryBoundary, provideEntry, useKernel } from 'diorama-ui'

export type { FileRendererProps } from './types.ts'

export const name = 'renderer-registry'
// `tabs` too: boot order is not registration order (it registers into
// `tabs.content` itself), and its seat declaration must exist before this
// piece's dispatch entry registers — otherwise both sit in the registry's
// pending queue and are retried out of order (docs/m0/spec.md §11.3 rule 3).
export const inject = ['slots', 'tabs']

/** The seat this piece owns and renders (contract.md §5). */
const DECLARE = {
  'file.renderer': { kind: 'keyed' },
} as const

/** Props of a `tabs.content` entry (one per tab, keyed by tab id). */
export interface RegistryContentProps {
  tab: TabInfo
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; props: FileRendererProps }
  | { status: 'error'; error: string }

/** What one tab has found so far about its file. */
interface TabState {
  /** The file as last stat'ed, once it exists. */
  info?: FileInfo
  /** Error from the stat (e.g. `ENOENT` for a deleted file). */
  error?: string
  /** The epoch this read belongs to; a read older than the current epoch
   *  re-stats (`view.refresh`). */
  force: number
  /** Set by a reported change to this tab's path: re-stat on the next pass. */
  changed: boolean
}

const CACHE = new WeakMap<MountHandle, FileCache>()

const LOADING: Loaded = { status: 'loading' }

/**
 * Per-mount state: the tab reads, and the content of files by path.
 *
 * `tabState` / `keyOf` / `contentOf` are pure — they never start IO (a store
 * read runs during React's render/commit, and IO started there re-enters the
 * store until the tree thrashes, docs/m1/spec.md §6.2 rule 7). `ensure` is the
 * effect-side call that starts the work.
 */
class FileCache {
  private readonly tabs = new Map<string, TabState>()
  private readonly contents = new Map<string, { stamp: string; state: Loaded }>()
  private readonly loads = new Set<string>()
  /** Tabs with a stat/read in flight. */
  private readonly inflight = new Set<string>()
  /** Bumped on every notify: the stable `useSyncExternalStore` snapshot. */
  private version = 0
  private readonly listeners = new Set<() => void>()
  /** `view.refresh` bumps this: every tab re-stats and re-reads once. */
  private epoch = 0

  tabState(tabId: string): TabState | undefined {
    return this.tabs.get(tabId)
  }

  /** Whether a tab's last attempt predates the current epoch. */
  stale(tabId: string): boolean {
    const state = this.tabs.get(tabId)
    return state === undefined || state.force < this.epoch
  }

  /** The render-visible read key of a tab (change it → effects re-run). */
  keyOf(tabId: string): string {
    const state = this.tabs.get(tabId)
    if (state === undefined) return 'new'
    return `${state.force}:${state.changed ? 1 : 0}:${state.info === undefined ? '' : stampOf(state.info)}:${state.error ?? ''}`
  }

  /**
   * A watched file changed: if one of the open tabs shows it, that tab re-stats
   * (and then re-reads) on its next pass. Unrelated paths are a no-op.
   */
  changed(path: string): void {
    let hit = false
    for (const [tabId, state] of this.tabs) {
      if (state.info?.path !== path && state.error === undefined) continue
      if (state.info?.path !== path) continue
      this.tabs.set(tabId, { ...state, changed: true })
      hit = true
    }
    if (hit) this.notify()
  }

  /** Content for a `FileInfo`; pure (see the class comment). */
  contentOf(file: FileInfo): Loaded {
    const entry = this.contents.get(file.path)
    if (entry === undefined || entry.stamp !== stampOf(file)) return LOADING
    return entry.state
  }

  /**
   * Stat the tab's path (when needed) and, once fresh, read its content.
   * `force` = a change was reported: re-stat even if the last stat succeeded.
   */
  ensure(mount: MountHandle, tabId: string, path: string, force = false): void {
    const state = this.tabs.get(tabId)
    const fresh = state !== undefined && state.force >= this.epoch && !state.changed
    if (!force && fresh) return
    // One stat/read in flight per tab: the effect may run again while the first
    // pass is still on the wire (and `force`/epoch alone cannot tell).
    if (this.inflight.has(tabId)) return
    const epoch = this.epoch
    this.inflight.add(tabId)
    const next: TabState = { force: epoch, changed: false }
    this.tabs.set(tabId, next)
    void this.statAndRead(mount, tabId, path, epoch).finally(() => {
      this.inflight.delete(tabId)
      this.notify()
    })
  }

  /** Drop what is known about a tab (its seat unmounted). */
  forget(tabId: string): void {
    this.tabs.delete(tabId)
  }

  /** Re-stat and re-read every open tab (`view.refresh`). */
  refresh(): void {
    this.epoch++
    this.notify()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async statAndRead(mount: MountHandle, tabId: string, path: string, epoch: number): Promise<void> {
    let info: FileInfo
    try {
      if (mount?.fs?.stat === undefined) throw new Error('renderer-registry: the mount handle has no fs')
      info = await mount.fs.stat(path)
    } catch (error) {
      // A deleted (or unreadable) file: say so instead of showing stale text.
      this.tabs.set(tabId, { force: epoch, changed: false, error: describeError(error) })
      this.notify()
      return
    }
    this.tabs.set(tabId, { force: epoch, changed: false, info })
    this.notify()
    await this.read(mount, info)
  }

  private async read(mount: MountHandle, file: FileInfo): Promise<void> {
    const stamp = stampOf(file)
    const current = this.contents.get(file.path)
    if (current !== undefined && current.stamp === stamp) return
    if (this.loads.has(file.path)) return
    this.loads.add(file.path)
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
    } finally {
      this.loads.delete(file.path)
    }
    this.contents.set(file.path, { stamp, state })
    this.notify()
  }

  /** Stable snapshot for `useSyncExternalStore` (React compares by identity). */
  getVersion = (): number => this.version

  private notify(): void {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }
}

/** The content key of a file: a read is reused while it does not move. */
function stampOf(file: FileInfo): string {
  return `${file.size}:${file.mtime}`
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
  // `subscribe` / `getVersion` are stable references (bound once per cache):
  // an inline snapshot closure is new every render, which makes React drop and
  // re-add the subscription on each pass and never see the update.
  const version = useSyncExternalStore(cache.subscribe, cache.getVersion)
  const state = cache.tabState(tab.id)
  const readKey = `${version}:${cache.keyOf(tab.id)}`
  const file = state?.info
  const loaded: Loaded = file === undefined ? LOADING : cache.contentOf(file)
  // The stat/read effect: runs for a new tab, after a reported change, after
  // `view.refresh` (both move `readKey`), or when the content of a known file
  // moved. `ensure` is a no-op when the read is current, so this is cheap.
  useEffect(() => {
    cache.ensure(mount, tab.id, tab.path)
  }, [cache, mount, tab.id, tab.path, readKey])
  // A closed tab's seat disappears; forget its read so ids do not accumulate.
  const forget = useEffectEvent(() => cache.forget(tab.id))
  useEffect(() => () => forget(), [])

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
  const mime = file === undefined ? 'application/octet-stream' : mimeOf(file.path)
  const ready = loaded.status === 'ready'
  const readyProps = ready ? loaded.props : undefined

  // The chooser runs in an effect (probes may need IO), but its inputs are
  // compared by content: the seat list and props are rebuilt every render, and
  // re-running it per render would `setChoice` for ever.
  const loadedKey = readyProps === undefined ? '' : `${readyProps.file.path}:${readyProps.file.size}:${readyProps.file.mtime}:${readyProps.text === undefined ? 'bytes' : 'text'}`
  const seatKey = seat.map(entry => entry.id).join(',')
  const choiceKey = `${loadedKey}|${seatKey}|${mime}`
  const [choice, setChoice] = useState<{ key: string; value: Chosen | 'unresolved' } | undefined>(undefined)
  const choose = useEffectEvent(() => {
    if (file === undefined) return Promise.resolve<RendererChoice>({ kind: 'empty' })
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
    if (!ready || file === undefined) return
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

  if (state?.error !== undefined) {
    return (
      <div className="diorama-renderer diorama-renderer__error" role="alert" data-testid="renderer-read-error">
        {state.error}
      </div>
    )
  }
  if (file === undefined) {
    return (
      <div className="diorama-renderer" data-testid="renderer-loading">
        正在读取 {tab.path}…
      </div>
    )
  }
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
  const chosen = choice !== undefined && choice.key === choiceKey ? choice.value : undefined
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
  // `tabs.content` is keyed by tab id (contract.md §5): one dispatch entry per
  // open tab, registered as the tab list changes. The registry then owns the
  // per-seat dispatch; this piece only decides what each entry renders.
  const tabs = (ctx as unknown as { tabs?: { getSnapshot(): { tabs: readonly TabInfo[] }; subscribe(listener: () => void): () => void } }).tabs
  if (tabs === undefined) {
    throw new Error('renderer-registry requires the "tabs" service (declare it in `inject`)')
  }
  const registered = new Map<string, () => void>()
  const sync = (): void => {
    const open = new Set(tabs.getSnapshot().tabs.map(tab => tab.id))
    for (const [tabId, dispose] of registered) {
      if (open.has(tabId)) continue
      dispose()
      registered.delete(tabId)
    }
    for (const tabId of open) {
      if (registered.has(tabId)) continue
      registered.set(
        tabId,
        provideEntry(ctx, { id: `renderer-registry:tab:${tabId}`, name: 'tabs.content', key: tabId, order: 100 }, RegistryContent),
      )
    }
  }
  ctx.effect(() => {
    sync()
    return tabs.subscribe(sync)
  }, 'renderer-registry: tabs.content seats')
  ctx.effect(
    () => () => {
      for (const dispose of registered.values()) dispose()
      registered.clear()
    },
    'renderer-registry: release seats',
  )
}
