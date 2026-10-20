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
import TimerService from '@cordisjs/plugin-timer'
import { CONTRACT_VERSION, KERNEL_NAME } from '../contract.ts'
import type { EffectiveConfig } from './config.ts'
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
  /** The effective `diorama.toml` + CLI configuration (contract.md §4.1). */
  config?: EffectiveConfig
  /** The mount's HTTP port (contract.md §3.5). */
  port?: number
  /** The mount's page origin, e.g. `http://127.0.0.1:54321/`. */
  url?: string
  /** The `diorama.toml` the configuration came from; absent = defaults. */
  configFile?: string
}

/** The mount registry a service plugin draws its per-directory instance from. */
export interface Mounts {
  onMount(cb: (mountCtx: Context, info: MountInfo) => (() => void) | void): () => void
  list(): MountInfo[]
  /** Kernel-internal: register a forked mount (plugin code never calls this). */
  __mount(mountCtx: Context, info: MountInfo): () => void
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
  isolate(name: string, label?: symbol): Context
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

/** A loaded fiber, as the loader inspects it (Cordis' own object). */
interface LoadedFiber {
  state?: number
  error?: unknown
  await?(): Promise<unknown>
}

/**
 * Create the mount registry and the `ctx.diorama` face (contract.md §3.5).
 *
 * Timing is part of the contract: a callback registered after a mount exists
 * is applied to every existing mount immediately; a callback registered before
 * one is applied when that mount forks. Unmount runs each callback's disposer
 * and forgets the mount (contract.md §2.5).
 */
export function createMounts(): {
  face: DioramaFace
  mount(mountCtx: Context, info: MountInfo): () => void
} {
  const mounted = new Map<string, MountInfo>()
  const contexts = new Map<string, Context>()
  const callbacks = new Map<(mountCtx: Context, info: MountInfo) => (() => void) | void, Map<string, () => void>>()
  const log = (message: string) => console.error(message)

  const applyTo = (
    cb: (mountCtx: Context, info: MountInfo) => (() => void) | void,
    mountId: string,
  ): void => {
    const ctx = contexts.get(mountId)
    const info = mounted.get(mountId)
    if (ctx === undefined || info === undefined) return
    let disposers = callbacks.get(cb)
    if (disposers === undefined) {
      disposers = new Map()
      callbacks.set(cb, disposers)
    }
    try {
      const result = cb(ctx, info)
      disposers.set(mountId, typeof result === 'function' ? result : () => {})
    } catch (failure) {
      // One callback's failure is that plugin's failure on that mount: the
      // others still run (contract.md §2.5), and the error is reported.
      disposers.set(mountId, () => {})
      log(`[mount:${mountId}] error: an onMount callback failed: ${(failure as Error)?.message ?? String(failure)}`)
      reportMountFailure(mountId, failure)
    }
  }

  const mount = (mountCtx: Context, info: MountInfo): (() => void) => {
    mounted.set(info.mountId, info)
    contexts.set(info.mountId, mountCtx)
    for (const cb of callbacks.keys()) applyTo(cb, info.mountId)
    return () => {
      mounted.delete(info.mountId)
      contexts.delete(info.mountId)
      for (const disposers of callbacks.values()) {
        const dispose = disposers.get(info.mountId)
        disposers.delete(info.mountId)
        try {
          dispose?.()
        } catch (failure) {
          log(`[mount:${info.mountId}] error: an onMount disposer failed: ${(failure as Error)?.message ?? String(failure)}`)
          reportMountFailure(info.mountId, failure)
        }
      }
    }
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
      __mount: mount,
    },
  }

  return { face, mount }
}

/** Hooks for reporting a mount-level failure (set by the gateway, contract.md §11.1). */
const mountFailureListeners = new Set<(mountId: string, failure: unknown) => void>()

/** Observe mount-level failures (an `onMount` callback or disposer threw). */
export function onMountFailure(listener: (mountId: string, failure: unknown) => void): () => void {
  mountFailureListeners.add(listener)
  return () => {
    mountFailureListeners.delete(listener)
  }
}

function reportMountFailure(mountId: string, failure: unknown): void {
  for (const listener of mountFailureListeners) {
    try {
      listener(mountId, failure)
    } catch {
      // A failing listener must not break the unmount it observes.
    }
  }
}

/**
 * Load plugins in order. A plugin that fails the minimal plugin shape is
 * reported and skipped; the rest still load (M0 acceptance point 5).
 *
 * A plugin's `apply` also leaves deferred effects behind (`ctx.provide(...)`
 * runs inside an effect). Cordis fires those only *after* the fiber becomes
 * active, and firing them calls `reflect.notify`, which re-runs every PENDING
 * fiber whose `inject` mentions the name — inside that fiber. A later plugin
 * that is early in the boot graph would then `apply` before an earlier one,
 * and seat declarations could overtake the entries that need them (M2 S3 found
 * this with `renderer-registry` injecting `tabs`). `settle` drains the effect
 * queue after every plugin, so boot order is exactly the graph order.
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
      await (fiber as unknown as LoadedFiber).await?.()
      await settle()
      // Cordis does not throw when an injected service never appears: the fiber
      // stays PENDING and `apply` never runs. Turn that into a loud boot
      // failure instead of an undefined service later (contract.md §11).
      const state = (fiber as unknown as LoadedFiber).state
      if (typeof state === 'number' && state !== 2) {
        const reason = (fiber as unknown as LoadedFiber).error
        const message = `did not activate (state ${state}${reason === undefined ? ': an injected service is unavailable' : `: ${(reason as Error).message}`})`
        failures.push({ id: describePlugin(plugin), message })
        log(`[diorama] error: plugin ${describePlugin(plugin)} ${message}`)
      }
      fibers.push(fiber)
    } catch (error) {
      const id = describePlugin(plugin)
      failures.push({ id, message: (error as Error).message })
      log(`[diorama] error: plugin ${id} failed to load — ${(error as Error).message}`)
    }
  }
  return { fibers, failures }
}

/**
 * Let the microtask queue run until it is empty. Effects that only chain
 * promises (no timers) settle here; anything slower is a bug in the loader's
 * assumptions, so the bound is generous but finite (and still counts as done —
 * `await` above already resolved).
 */
async function settle(limit = 1000): Promise<void> {
  let rounds = 0
  while (rounds++ < limit) await Promise.resolve()
}

/**
 * The permanent half of the server tree (contract.md §2.5): a root context that
 * loads the plugin graph **once** and publishes `ctx.diorama`. Every mounted
 * directory forks from it, so plugin `apply` runs once per process while
 * services stay per directory.
 */
export interface PluginHost {
  root: Context
  mounts: Mounts
  failures: PluginFailure[]
  /** Load the plugin graph into the host (once per process). */
  load(plugins: readonly unknown[]): Promise<PluginFailure[]>
  /** Dispose the root context (takes every fork with it). */
  dispose(): Promise<void>
}

/** Create the root context, its `ctx.diorama` face and the timer service. */
export async function createPluginHost(log: (message: string) => void): Promise<PluginHost> {
  const root = new Context() as unknown as Context & CordisSurface
  // Timers as services (`ctx.timer.debounce` and friends). Installed first so a
  // plugin may `inject: ['timer']`; every timer an effect creates is disposed
  // with it (fs watch windows included).
  await loadPlugins(root, [TimerService], log)
  // `ctx.diorama` exists before any plugin applies, so a service plugin can
  // register on `mounts` during its own `apply` (contract.md §2.5).
  const mounts = createMounts()
  root.provide('diorama', mounts.face)
  return {
    root,
    mounts: mounts.face.mounts,
    failures: [],
    async load(plugins) {
      const { failures } = await loadPlugins(root, plugins, log)
      return failures
    },
    dispose: () => root.fiber.dispose(),
  }
}

/**
 * One mounted directory's tree (contract.md §2.5): a context forked from the
 * host's root, its per-directory services, and the order in which it is torn
 * down. Creating one does not stop the host/plugins.
 */
export interface MountTree {
  mountId: string
  /** The forked child context: `ctx.fs` / `ctx.mountId` live here. */
  ctx: Context
  fs: FsService
  info: MountInfo
  /** The host's disposer for this mount (also runs on {@link dispose}). */
  unmount(): void
  /** Unmount **and** dispose the forked context (contract.md §2.5 steps 3–4). */
  dispose(): Promise<void>
}

/**
 * Services every mount may provide, each isolated per mount (see
 * {@link mountScope}). A kernel service with a server half that a mount
 * provides belongs here; today that is `fs` and `git` (contract.md §3.1, §3.2).
 */
export const MOUNT_SERVICES = ['fs', 'git', 'search'] as const

/**
 * A context scoped to one mount: every {@link MOUNT_SERVICES} name resolves to
 * this mount's own key (`<mountId>:<name>`).
 *
 * Cordis isolates by **name**, never by fiber — `isolate` only labels the one
 * name it is given, and anything unlabelled falls back to the root's shared
 * default key. Label all of them here; a plugin with its own per-mount service
 * uses {@link isolateMountService}.
 */
export function mountScope(root: Context, mountId: string): Context {
  let scoped: Pick<Context, 'isolate'> = root
  for (const name of MOUNT_SERVICES) scoped = scoped.isolate(name, Symbol(`${mountId}:${name}`))
  return scoped as Context
}

/**
 * Isolate one more service for the mount a context belongs to (`ctx.mountId`),
 * for a server half that provides a service outside {@link MOUNT_SERVICES}.
 * Safe in the middle of a mount fiber: `isolate` only adds a label, so later
 * `plugin()` fibers inherit it.
 */
export function isolateMountService(ctx: Context, name: string): Context {
  const mountId = (ctx as unknown as { mountId?: string }).mountId
  if (mountId === undefined) throw new Error(`isolateMountService("${name}") needs a mount context (no ctx.mountId)`)
  // `isolate` returns `this` (an augmented Context); the cast keeps the signature plain.
  return (ctx as Pick<Context, 'isolate'>).isolate(name, Symbol(`${mountId}:${name}`)) as unknown as Context
}

/** Fork a mount context from the host root and fire `onMount` for it. */
export async function forkMount(host: PluginHost, options: {
  root: string
  mountId: string
  config?: EffectiveConfig
  port?: number
  url?: string
  configFile?: string
  log?: (message: string) => void
}): Promise<MountTree> {
  const log = options.log ?? ((message: string) => console.error(message))
  const bare = host.root as unknown as CordisSurface
  // Every mount gets its **own isolate key for every mount service** and its
  // **own plugin fiber** under it. Both are load-bearing:
  // - the keys keep `ctx.fs` / `ctx.git` out of the root and out of sibling
  //   mounts. Cordis isolates **per service name**, not per fiber: a name this
  //   mount does not isolate falls back to the root's default key
  //   (`Symbol(name)`), which is shared — two mounts of one repository then
  //   collide (`service "git" has been registered`) and the root can resolve
  //   the wrong mount's repository (docs/m4/spec.md);
  // - the fiber owns the `provide`, so disposing this mount rolls back only
  //   this mount's services. A bare `ctx.provide` on a shared fiber would
  //   delete every mount's `fs` when one of them is disposed.
  const ctx = mountScope(bare as unknown as Context, options.mountId) as unknown as Context & CordisSurface
  // `mountId` is a record, not a service: nothing injects it, and a plugin
  // reads it to learn which directory it was mounted for.
  Object.defineProperty(ctx as unknown as object, 'mountId', { value: options.mountId, configurable: true })
  const info: MountInfo = {
    root: options.root,
    mountId: options.mountId,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
  }
  // The mount's own fiber: services a plugin provides inside `onMount` land on
  // it (they are provided on `ctx` above, which is this fiber's context).
  let unmount: () => void = () => {}
  const fiber = await ctx.plugin({
    name: `mount:${options.mountId}`,
    apply(mountCtx: Context & CordisSurface) {
      Object.defineProperty(mountCtx as unknown as object, 'mountId', { value: options.mountId, configurable: true })
      unmount = host.mounts.__mount(mountCtx as unknown as Context, info)
    },
  })
  // The fiber is active only after the deferred effects ran: read the services
  // it provided, not before (`provide` is an effect, like every Cordis plugin).
  await (fiber as unknown as { await?(): Promise<unknown> }).await?.()
  const fs = (ctx as unknown as { get(name: string): unknown }).get('fs')
  if (!(fs instanceof FsService)) {
    log(`[mount:${options.mountId}] error: no plugin provided "fs" on the mount; plugins that inject fs will not activate`)
  }
  return {
    mountId: options.mountId,
    ctx: ctx as unknown as Context,
    fs: fs instanceof FsService ? fs : new FsService(options.root, { ignore: options.config?.ignore }),
    info,
    unmount() {
      unmount()
    },
    async dispose() {
      // contract.md §2.5, steps 3–4: the plugin disposers run first (they may
      // still use the mount), then the fiber goes away and takes the services.
      unmount()
      // `fiber` is the return value of `ctx.plugin`, i.e. the Fiber itself.
      await (fiber as unknown as { dispose(): Promise<void> }).dispose()
    },
  }
}

export async function bootPlugins(options: {
  plugins: readonly unknown[]
  root: string
  mountId: string
  /** Effective configuration for this mount (contract.md §4.1). */
  config?: EffectiveConfig
  log?: (message: string) => void
}): Promise<ServerTree> {
  const log = options.log ?? ((message: string) => console.error(message))
  const host = await createPluginHost(log)
  const failures = await host.load(options.plugins)
  const tree = await forkMount(host, { root: options.root, mountId: options.mountId, config: options.config, log })
  return {
    root: host.root,
    mount: tree.ctx,
    fs: tree.fs,
    mounts: host.mounts,
    failures,
    async stop() {
      await tree.dispose()
      await host.dispose()
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
