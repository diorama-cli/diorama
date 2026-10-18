/**
 * Server half of the Cordis plugin tree (architecture.md §11).
 *
 * M0 serves one directory per process, so there is exactly one root context and
 * one mount context forked from it. Plugin code is global, services are per
 * directory: after every plugin had its chance to `apply` (once, on the root),
 * the kernel forks the mount, seats `ctx.fs` there as a real Cordis service and
 * publishes it via `ctx.provide`, so a plugin that injects `fs` only activates
 * inside a mount (contract.md §2.5).
 */
import { Context } from 'cordis'
import { FsService } from './fs.ts'

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
  failures: PluginFailure[]
  stop(): Promise<void>
}

export interface LoadPluginsResult {
  fibers: unknown[]
  failures: PluginFailure[]
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
  const { failures } = await loadPlugins(root, options.plugins, log)

  // Mount scope: a per-directory service instance and the directory's fs.
  // Provided on the *root* tree in M0, where every plugin's context sees it
  // through the root's isolate map; M4's gateway moves it onto the mount fork.
  const fs = new FsService(options.root)
  const mount = root.isolate('fs') as unknown as Context & CordisSurface
  const disposeMountId = mount.provide('mountId', options.mountId)
  const disposeFs = mount.provide('fs', fs)

  return {
    root,
    mount,
    fs,
    failures,
    async stop() {
      disposeFs()
      disposeMountId()
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
