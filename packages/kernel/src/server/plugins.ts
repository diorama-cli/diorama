/**
 * Server half of the Cordis plugin tree (architecture.md §11, contract.md §2.5).
 *
 * M1 serves one directory per process, so there is exactly one root context and
 * one mount context forked from it. Plugin code is global, services are per
 * directory: plugins `apply` once on the root; the kernel then provides
 * `ctx.diorama` (with `mounts`) and fires `onMount`, so a service plugin such as
 * `fs` instantiates itself on the mount (contract.md §2.5). Reading `ctx.fs` on
 * the root fails — that is what stops a plugin from acting on the wrong
 * directory.
 */
import { Context } from 'cordis'
import { CONTRACT_VERSION, KERNEL_NAME } from '../contract.ts'
import { FsService } from './fs.ts'

/** What the kernel publishes on the root as `ctx.diorama`. */
export interface DioramaFace {
  readonly name: string
  readonly contract: string
  readonly mounts: Mounts
}

/** One mounted directory (contract.md §3.5). */
export interface MountInfo {
  root: string
  mountId: string
}

/** The mount registry a service plugin draws its per-directory instance from. */
export interface Mounts {
  onMount(cb: (mountCtx: Context, info: MountInfo) => (() => void) | void): () => void
  list(): MountInfo[]
}

declare module 'cordis' {
  interface Context {
    /** Kernel face: name, contract version, mount registry (contract.md §3.5). */
    diorama: DioramaFace
  }
}

/** The parts of the Cordis context the tree uses (declared locally on purpose). */
interface CordisSurface {
  plugin(plugin: object): PromiseLike<unknown>
  fiber: { dispose(): Promise<void> }
  isolate(name: string): Context
  provide(name: string, value: unknown): () => void
}

export interface PluginFailure {
  /** Plugin id (`plugin.name`), or a description when it has none. */
  id: string
  message: string
}

export interface ServerTree {
  root: Context
  /** Mount context holding `ctx.fs`. */
  mount: Context
  fs: FsService
  mounts: Mounts
  failures: PluginFailure[]
  stop(): Promise<void>
}

export interface LoadPluginsResult {
  fibers: unknown[]
  failures: PluginFailure[]
}

/**
 * Create the mount registry and the `ctx.diorama` face. A callback registered
 * after its mount exists (plugin order is not the mount's concern) is called
 * immediately with that mount; the `onMount` disposer runs the callback's own
 * disposer for every mount it was applied to.
 */
export function createMounts(): {
  face: DioramaFace
  mount(mountCtx: Context, info: MountInfo): () => void
} {
  const mounted = new Map<string, MountInfo>()
  const contexts = new Map<string, Context>()
  const callbacks = new Map<(mountCtx: Context, info: MountInfo) => (() => void) | void, Map<string, () => void>>()

  const applyTo = (
    cb: (mountCtx: Context, info: MountInfo) => (() => void) | void,
    mountId: string,
  ): void => {
    const ctx = contexts.get(mountId)
    const info = mounted.get(mountId)
    if (ctx === undefined || info === undefined) return
    const result = cb(ctx, info)
    let disposers = callbacks.get(cb)
    if (disposers === undefined) {
      disposers = new Map()
      callbacks.set(cb, disposers)
    }
    disposers.set(mountId, typeof result === 'function' ? result : () => {})
  }

  const face: DioramaFace = {
    name: KERNEL_NAME,
    contract: CONTRACT_VERSION,
    mounts: {
      onMount(cb) {
        callbacks.set(cb, new Map())
        for (const mountId of mounted.keys()) applyTo(cb, mountId)
        return () => {
          const disposers = callbacks.get(cb)
          callbacks.delete(cb)
          for (const dispose of disposers?.values() ?? []) dispose()
        }
      },
      list: () => [...mounted.values()],
    },
  }

  return {
    face,
    mount(mountCtx, info) {
      mounted.set(info.mountId, info)
      contexts.set(info.mountId, mountCtx)
      for (const cb of callbacks.keys()) applyTo(cb, info.mountId)
      return () => {
        mounted.delete(info.mountId)
        contexts.delete(info.mountId)
        for (const disposers of callbacks.values()) {
          disposers.get(info.mountId)?.()
          disposers.delete(info.mountId)
        }
      }
    },
  }
}

/**
 * Load plugins in order. A plugin that fails the minimal plugin shape is
 * reported and skipped; the rest still load (M0 acceptance point 5).
 */
export async function loadPlugins(
  ctx: Context & CordisSurface,
  plugins: readonly unknown[],
  log: (message: string) => void,
): Promise<LoadPluginsResult> {
  const failures: PluginFailure[] = []
  const fibers: LoadPluginsResult['fibers'] = []
  for (const [index, plugin] of plugins.entries()) {
    const problem = pluginProblem(plugin)
    if (problem !== undefined) {
      const id = describePlugin(plugin)
      failures.push({ id, message: problem })
      log(`[diorama] error: plugin #${index + 1} ${id} ${problem} — skipped`)
      continue
    }
    try {
      const fiber = await ctx.plugin(plugin as object)
      // A plugin whose `apply` returned synchronously is not finished yet: the
      // body runs as Cordis' fiber effect. Finish loading it before the next.
      await (fiber as unknown as { await?(): Promise<unknown> }).await?.()
      fibers.push(fiber)
    } catch (error) {
      const id = describePlugin(plugin)
      failures.push({ id, message: (error as Error).message })
      log(`[diorama] error: plugin ${id} failed to load — ${(error as Error).message}`)
    }
  }
  return { fibers, failures }
}

/** Boot the server plugin tree for one served directory. */
export async function bootPlugins(options: {
  plugins: readonly unknown[]
  root: string
  mountId: string
  log?: (message: string) => void
}): Promise<ServerTree> {
  const log = options.log ?? ((message: string) => console.error(message))
  const root = new Context() as unknown as Context & CordisSurface

  // `ctx.diorama` exists before any plugin applies, so a service plugin can
  // register on `mounts` during its own `apply` (contract.md §2.5).
  const mounts = createMounts()
  root.provide('diorama', mounts.face)

  const { failures } = await loadPlugins(root, options.plugins, log)

  // Mount scope: a per-directory service instance and the directory's fs.
  // `isolate` gives the mount its own `fs` (and `mountId`) slot; a service
  // plugin provides into it from inside `onMount`.
  const mount = root.isolate('fs') as unknown as Context & CordisSurface
  mount.provide('mountId', options.mountId)
  const info: MountInfo = { root: options.root, mountId: options.mountId }
  const unmount = mounts.mount(mount as unknown as Context, info)
  const fs = (mount as unknown as { get(name: string): unknown }).get('fs')
  if (!(fs instanceof FsService)) {
    log(`[diorama] error: no plugin provided "fs" on the mount; plugins that inject fs will not activate`)
  }

  return {
    root,
    mount,
    fs: fs instanceof FsService ? fs : new FsService(options.root),
    mounts: mounts.face.mounts,
    failures,
    async stop() {
      unmount()
      await root.fiber.dispose()
    },
  }
}

/** Why a plugin object is not a valid Cordis plugin half, if it is not. */
export function pluginProblem(plugin: unknown): string | undefined {
  if (plugin === null || (typeof plugin !== 'function' && typeof plugin !== 'object')) {
    return 'is not a plugin (expected a function or an object with apply())'
  }
  const record = plugin as { name?: unknown; apply?: unknown }
  if (typeof plugin !== 'function' && typeof record.apply !== 'function') {
    return 'is not a plugin (expected a function or an object with apply())'
  }
  if (typeof record.name !== 'string' || record.name.trim() === '') {
    return 'does not declare a "name" export'
  }
  return undefined
}

/** Best-effort identification of a plugin for log messages. */
export function describePlugin(plugin: unknown): string {
  const record = plugin as { name?: unknown; apply?: unknown } | null
  if (typeof record?.name === 'string' && record.name !== '') return `"${record.name}"`
  const applyName = typeof record?.apply === 'function' ? record.apply.name : undefined
  if (typeof applyName === 'string' && applyName !== '') return `(apply: ${applyName}, missing name)`
  if (typeof plugin === 'function' && plugin.name !== '') return `(function: ${plugin.name}, missing name)`
  return '(anonymous plugin, missing name)'
}
