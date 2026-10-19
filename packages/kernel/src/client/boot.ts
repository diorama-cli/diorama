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
import { collectCommandContext, createCommandsService, type CommandContext, type CommandContextSources } from './commands.ts'
import { createMountHandle, type MountHandle, type MountManifest } from './mount.ts'
import {
  ensurePageBridge,
  installKernel,
  notifyKernel,
  type KernelContextValue,
  type KernelPageApi,
  type KernelSlotRegistry,
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

/** Where the page's `CommandContext` comes from (the kernel collects it). */
export interface CommandContextHook {
  /** Installed once the page boots; pieces may add sources (they are read lazily). */
  sources: CommandContextSources
}
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
   * Track keyboard focus for `CommandContext.focus` (defaults to the document,
   * which is where the single key listener is installed). Tests omit it.
   */
  attachKeyboard?: boolean
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
  // `ctx.commands` is kernel infrastructure (contract.md §3.7): one registry,
  // bound to the page, present even when no palette piece is in the graph.
  const focus = createFocusTracker()
  const commands = createCommandsService({
    context: () => collectCommandContext({ ...focus.sources, mountId: handle.mountId }),
    warn: message => log(`[diorama] ${message}`),
  })
  ctx.provide('commands', commands)
  const disposeKeyboard = options.attachKeyboard === false ? () => {} : installKeyboard(commands, focus)

  const failures = await loadManifest(ctx, options, log, handle ?? createMountHandle(options.manifest))
  // The context a component sees. Every read resolves through core's `get`, so a
  // service provided after the tree root was created is still found (the root's
  // bare property reads are fixed when the provision happens).
  const pageContext = createPageContext(ctx)
  installKernel({
    views: ctx.get('views') as KernelContextValue['views'],
    // The seat table itself, so components can read any seat (not only the
    // ones they own) without owning its registration (contract.md §5).
    registry: ctx.get('slotRegistry') as KernelSlotRegistry | undefined,
    ctx: pageContext,
    mount: handle,
  })
  return {
    ctx: pageContext as unknown as Context,
    mount: handle,
    failures,
    dispose: async () => {
      disposeKeyboard()
      await ctx.fiber.dispose()
    },
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
const LATE_SERVICES = ['views', 'slots', 'slotRegistry', 'tabs', 'tree', 'fs', 'kernel', 'commands'] as const

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
  // Boot graph = the selection plus the infrastructure its entries require
  // (contract.md §1). `requires` is completed here so a plugin that forgets to
  // list `slots` still gets it when it is in the manifest.
  const graph = completeGraph(options.manifest.plugins)
  for (const plugin of graph) {
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
      const pending = ctx.plugin(module as PluginModule)
      await pending

      // Deferred effects (`ctx.provide(...)` runs inside one) fire only once the
      // fiber is active, and firing them re-runs PENDING fibers whose `inject`
      // matches — possibly one booted earlier in the graph. Drain the queue so
      // the next plugin applies only after this one is fully in effect.
      await settle()
      // Cordis does not throw when an injected service never appears: the fiber
      // stays PENDING (0/1) and `apply` never runs. Turn that into a loud boot
      // failure instead of an undefined service later (contract.md §11).
      const state = (pending as unknown as { state?: number }).state
      if (typeof state === 'number' && state !== 2) {
        const message = `did not activate (state ${state}: an injected service is unavailable)`
        failures.push({ id: plugin.id, message })
        log(`[diorama] error: plugin "${plugin.id}" ${message}`)
        continue
      }
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

/**
 * Focus tracking for `CommandContext`: the page records which surface the
 * user last interacted with. Pieces never query the DOM for this.
 */
function createFocusTracker(): { sources: Omit<CommandContextSources, 'mountId'>; note(event: Event): void } {
  let current: CommandContext['focus'] = 'other'
  const note = (event: Event): void => {
    const target = event.target as Element | null
    if (target === null || typeof target.closest !== 'function') return
    const active = document.activeElement
    current = focusOf(target) ?? (active instanceof Element ? focusOf(active) : undefined) ?? 'other'
  }
  return {
    sources: { focus: () => current },
    note,
  }
}

/** Which surface an element belongs to, by the slots that carry them. */
function focusOf(element: Element): CommandContext['focus'] | undefined {
  if (element.closest('[data-slot="sidebar.tree"]') !== null) return 'tree'
  if (element.closest('[data-slot="layout.main"]') !== null) return 'tabs'
  if (element.closest('[contenteditable="true"], textarea, input, .diorama-palette') !== null) return 'editor'
  return undefined
}

/**
 * Whether a key press belongs to a surface that owns its keys (it never
 * triggers a command): text fields, and anything marked `data-command-keys` —
 * the palette, whose own field handles Escape / arrows / Enter.
 */
function inTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [data-command-keys]') !== null
}

/**
 * The page's only `keydown` listener (contract.md §3.7): one dispatcher, so
 * two pieces cannot fight over a key. Returns its disposer.
 */
function installKeyboard(commands: { handleKey(event: KeyboardEvent & { repeat?: boolean }): boolean }, focus: { note(event: Event): void }): () => void {
  if (typeof document === 'undefined') return () => {}
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    if (inTextEntry(event.target)) return
    if (commands.handleKey(event)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const onPointerDown = (event: Event): void => focus.note(event)
  const onFocusIn = (event: Event): void => focus.note(event)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('focusin', onFocusIn, true)
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('focusin', onFocusIn, true)
  }
}

/**
 * Let the microtask queue run until it is empty (see the note at the call
 * site). Effects that only promise chain settle here.
 */
async function settle(limit = 1000): Promise<void> {
  let rounds = 0
  while (rounds++ < limit) await Promise.resolve()
}

/**
 * Boot graph = the selection, with required infrastructure moved *in front* of
 * the plugins that need it (contract.md §1). The selection itself is unchanged:
 * `--plugins` decides what boots, `requires` only decides the order.
 */
function completeGraph(plugins: readonly MountManifest['plugins'][number][]): MountManifest['plugins'] {
  const available = new Map(plugins.map(plugin => [plugin.id, plugin]))
  const out: MountManifest['plugins'] = []
  const emitted = new Set<string>()
  const emit = (plugin: MountManifest['plugins'][number], stack: readonly string[]): void => {
    if (emitted.has(plugin.id)) return
    for (const required of plugin.requires ?? []) {
      if (stack.includes(required)) continue // a cycle; the required piece is already in flight
      const provider = available.get(required)
      if (provider !== undefined) emit(provider, [...stack, plugin.id])
    }
    emitted.add(plugin.id)
    out.push(plugin)
  }
  for (const plugin of plugins) emit(plugin, [])
  return out
}
