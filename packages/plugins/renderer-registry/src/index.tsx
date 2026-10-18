/**
 * renderer-registry — dispatch of `file.renderer` (contract.md §5, §5.1).
 *
 * Provides `ctx.renderers` (the dispatch policy, M0: a plain list) and
 * registers into `tabs.content`, declaring the `file.renderer` seat it owns.
 *
 * M0 policy: entries in ascending `order` mean "try me"; the first entry that
 * renders without throwing wins. A thrown entry is marked failed through
 * `ctx.views` and the next one is tried; when every entry has failed, the
 * errors are shown. With no entry at all (e.g. the `plaintext` piece was
 * removed) the seat says "无可用渲染器" instead of blanking — M0 acceptance
 * point 2.
 *
 * The file's text is read here, once, and handed to entries as props; a
 * renderer never does IO (docs/m0/spec.md §1).
 */
import type { Context } from 'cordis'
import type { ReactElement } from 'react'
import type { FileInfo, MountHandle, TabInfo } from 'diorama-kernel/client'
import type { FileRendererProps } from './types.ts'
import { Slot, useKernel, useStore } from 'diorama-ui'

export type { FileRendererProps } from './types.ts'

export const name = 'renderer-registry'
export const inject = ['slots']

const DECLARE = {
  'file.renderer': { kind: 'list' },
} as const

/** Props of the `tabs.content` entry. */
export interface RegistryContentProps {
  tab: TabInfo
}

type TextState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; error: string }

const CACHE = new WeakMap<MountHandle, FileCache>()

interface CacheEntry {
  stamp: string
  state: TextState
}

/** Per-mount text cache keyed by path, refreshed when size or mtime moves. */
class FileCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly listeners = new Set<() => void>()

  read(mount: MountHandle, file: FileInfo): TextState {
    const stamp = `${file.size}:${file.mtime}`
    const cached = this.entries.get(file.path)
    if (cached !== undefined && cached.stamp === stamp) return cached.state
    const entry: CacheEntry = { stamp, state: { status: 'loading' } }
    this.entries.set(file.path, entry)
    mount.fs.readText(file.path).then(
      text => {
        if (this.entries.get(file.path) !== entry) return
        entry.state = { status: 'ready', text }
        this.notify()
      },
      (error: unknown) => {
        if (this.entries.get(file.path) !== entry) return
        entry.state = { status: 'error', error: describeError(error) }
        this.notify()
      },
    )
    return entry.state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
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

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('EBINARY')) return '二进制文件，无法以文本显示'
  return message
}

function RegistryContent({ tab }: RegistryContentProps) {
  const { mount } = useKernel()
  const cache = cacheFor(mount)
  const state = useStore({
    subscribe: cache.subscribe,
    getSnapshot: () => cache.read(mount, tab.file),
  })
  if (state.status === 'loading') {
    return (
      <div className="diorama-renderer" data-testid="renderer-loading">
        正在读取 {tab.file.name}…
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="diorama-renderer diorama-renderer__error" role="alert" data-testid="renderer-read-error">
        {state.error}
      </div>
    )
  }
  const props: FileRendererProps = {
    file: tab.file,
    content: new TextEncoder().encode(state.text),
    mountCtx: mount,
  }
  return (
    <div className="diorama-renderer" data-testid="renderer">
      <Slot
        name="file.renderer"
        list
        props={props}
        empty={
          <div className="diorama-renderer__empty" role="status" data-testid="renderer-empty">
            无可用渲染器
          </div>
        }
        exhausted={errors => (
          <div className="diorama-renderer__error" role="alert" data-testid="renderer-failed">
            渲染失败：{errors.join('；')}
          </div>
        )}
        render={entry => {
          const Renderer = entry.component as unknown as (rendererProps: FileRendererProps) => ReactElement | null
          return (
            <div data-renderer={entry.id}>
              <Renderer {...props} />
            </div>
          )
        }}
      />
    </div>
  )
}

export function apply(ctx: Context) {
  ctx.slots.register({ id: 'renderer-registry:dispatch', name: 'tabs.content', order: 100, declare: DECLARE }, RegistryContent)
}
