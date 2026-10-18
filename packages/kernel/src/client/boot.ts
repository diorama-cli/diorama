/**
 * Boot a page: create the client Cordis tree, seat the page handle and the
 * mounting face, and load the plugins named by the boot manifest in order.
 *
 * This lives in the kernel because it is assembly infrastructure the pieces
 * build on (architecture.md §4: the shell holds the loader, boots the plugin
 * graph and mounts the renderer). The `slots` piece provides the registration
 * services itself, so nothing here knows about slots.
 *
 * Fail loud, single point: a module that cannot be resolved, or whose `name`
 * export differs from the manifest, is reported on the console naming the
 * plugin, recorded in `failures`, and skipped; the rest of the tree boots.
 *
 * Type note: this module deliberately never imports an augmentation from a
 * piece (`ctx.tabs`, `ctx.slots`, …). A top-level import would make bundlers
 * pull a second Cordis copy into the shell bundle. The kernel's own services
 * are typed locally through `KernelContext`.
 */
import { Context } from 'cordis'
import { createMountHandle, type MountHandle, type MountManifest } from './mount.ts'
import {
  ensurePageBridge,
  installKernel,
  notifyKernel,
  type KernelContextValue,
  type KernelPageApi,
} from './page.ts'

/** One plugin the shell could not load. */
export interface BootFailure {
  id: string
  message: string
}

/** The `ctx.mounts` face: ownership of a client Cordis tree. */
export interface MountsFace {
  /** Client plugins draw their page chrome through this context. */
  readonly ctx: Context
  /** The page handle of this mount. */
  readonly handle: MountHandle
}

/** Services the kernel itself provides on the client tree. */
export interface KernelServices {
  /** The page handle (`mountCtx`). */
  mount: MountHandle
  /** The mounting face. */
  mounts: MountsFace
}

/** A Cordis context with exactly the kernel's own services. */
export type KernelContext = Context & KernelServices
/** How a plugin module looks to the loader. */
type PluginModule = object

/**
 * Provide a plain context record and undo it when the tree unloads.
 *
 * Cordis hides records published on a plugin's child context from every other
 * context, and its Proxy refuses `set` for a name nobody provides. Records are
 * therefore only meaningful on the tree root — the shell's own context — which
 * is where the kernel puts them (docs/m0/spec.md §3.1: records are data, not
 * services).
 */
export function provideRecord(ctx: object & { effect(execute: () => () => void, label?: string): unknown }, record: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(record)) {
    Object.defineProperty(ctx, name, { value, configurable: true })
  }
  ctx.effect(() => () => {
    for (const name of Object.keys(record)) delete (ctx as Record<string, unknown>)[name]
  }, 'kernel: context records')
}

export interface BootOptions {
  /** Boot metadata from `/plugin.json`. */
  manifest: MountManifest
  /** The page handle, when the shell already built it (same object as `BootResult.mount`). */
  mount?: MountHandle
  /** Resolve a plugin id to its client-half module (the shell's module table). */
  resolve(id: string): Record<string, unknown> | Promise<Record<string, unknown>>
  /** Console sink for skipped plugins. Defaults to `console.warn`. */
  log?: (message: string) => void
  /**
   * Called once the `slots` piece has activated and before any other piece:
   * the place to publish the page kernel, so pieces that render during
   * registration already see a complete page. It receives the mount handle,
   * which only the kernel knows how to build.
   */
  onBeforePlugins?: (ctx: Context, mount: MountHandle) => void
}

export interface BootResult {
  ctx: Context
  mount: MountHandle
  failures: BootFailure[]
  dispose(): Promise<void>
}

/** Create the client tree and boot every plugin in the boot manifest. */
export async function bootClient(options: BootOptions): Promise<BootResult> {
  const log = options.log ?? ((message: string) => console.warn(message))
  const handle = createMountHandle(options.manifest)
  // A root context with this Program's augmentations plus the loader's surface.
  // (A `Context & …` intersection is not how a plugin's child context is typed;
  // the copy goes through `unknown` so the runtime object stays a real context.)
  const ctx = new Context() as unknown as KernelContext & CordisSurface
  // The kernel's two client services — real Cordis services, so child contexts
  // and plugins can `inject` them.
  ctx.provide('mount', handle)
  const mounts: MountsFace = { ctx: ctx as unknown as Context, handle }
  ctx.provide('mounts', mounts)
  // The page bridge exists before any piece boots (this module also creates it
  // in the shell); the kernel installs itself through it below.
  ensurePageBridge()
  const kernelApi: KernelPageApi = {
    refresh: notifyKernel,
    onSlotChange(subscribe) {
      ctx.effect(() => subscribe(notifyKernel), 'kernel: slot changes')
    },
  }
  ctx.provide('kernel', kernelApi)

  const failures = await loadManifest(ctx, options, log, handle ?? createMountHandle(options.manifest))
  // The context a component sees. Every read resolves through core's `get`, so a
  // service provided after the tree root was created is still found (the root's
  // bare property reads are fixed when the provision happens).
  const pageContext = createPageContext(ctx)
  installKernel({
    views: ctx.get('views') as KernelContextValue['views'],
    ctx: pageContext,
    mount: handle,
  })
  return {
    ctx: pageContext as unknown as Context,
    mount: handle,
    failures,
    dispose: () => ctx.fiber.dispose(),
  }
}

/** The parts of the Cordis context the loader calls. */
interface CordisSurface {
  get(name: string): unknown
  isolate(name: string): KernelContext
  provide(name: string, value: unknown): () => void
  effect(execute: () => () => void, label?: string): unknown
  plugin(plugin: PluginModule): PromiseLike<unknown>
  fiber: { dispose(): Promise<void> }
}

/** Services a piece provides after the tree root exists. */
const LATE_SERVICES = ['views', 'slots', 'slotRegistry', 'tabs', 'tree', 'fs', 'kernel'] as const

/** A context whose reads always go through core's `get` (see `bootClient`). */
function createPageContext(ctx: KernelContext & CordisSurface): KernelContext & CordisSurface {
  const page = ctx.extend({ diorama: { mountId: ctx.mount.mountId } }) as unknown as KernelContext &
    CordisSurface &
    Record<string, unknown>
  for (const name of LATE_SERVICES) {
    Object.defineProperty(page, name, {
      configurable: true,
      get: () => ctx.get(name),
    })
  }
  return page
}

async function loadManifest(
  ctx: KernelContext & CordisSurface,
  options: BootOptions,
  log: (message: string) => void,
  mount: MountHandle,
): Promise<BootFailure[]> {
  const failures: BootFailure[] = []
  for (const plugin of options.manifest.plugins) {
    let module: Record<string, unknown>
    try {
      module = await options.resolve(plugin.id)
    } catch (error) {
      failures.push({ id: plugin.id, message: (error as Error).message })
      log(`[diorama] error: plugin "${plugin.id}" could not be loaded: ${(error as Error).message}`)
      continue
    }
    if (module.name !== plugin.name) {
      const message = `does not declare the expected name "${plugin.name}" (got ${String(module.name)})`
      failures.push({ id: plugin.id, message })
      log(`[diorama] error: plugin "${plugin.id}" ${message} — skipped`)
      continue
    }
    try {
      await ctx.plugin(module as PluginModule)
      if (plugin.id === 'slots' && options.onBeforePlugins !== undefined) {
        options.onBeforePlugins(ctx as unknown as Context, mount)
      }
    } catch (error) {
      failures.push({ id: plugin.id, message: (error as Error).message })
      log(`[diorama] error: plugin "${plugin.id}" failed to apply: ${(error as Error).message}`)
    }
  }
  return failures
}
