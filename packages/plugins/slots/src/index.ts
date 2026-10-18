/**
 * slots — the client half of the slot registry (contract.md §3.3).
 *
 * Loaded first: it provides `ctx.slots` (registration) and `ctx.views`
 * (observation, including "the seat is empty" and "this entry failed") before
 * any piece that registers into a seat activates. Page chrome that is not
 * itself a slot entry — the failure panel shown when `root` is empty — reads
 * `ctx.views` directly.
 */
import type { Context } from 'cordis'
import type { MountHandle } from 'diorama-kernel'
import type { KernelPageApi, PageBridge } from 'diorama-kernel/client'

/**
 * Register a seat subscription on the page bridge the shell installed. The
 * bridge is one page global (`__diorama_page__`); a half must not reach it
 * through `diorama-kernel/client`, because its own build of that module would
 * create a separate bridge.
 */
/** Whether a browser page bridge exists (the server tree has none). */
function pageBridgePresent(): boolean {
  return (globalThis as unknown as { __diorama_page__?: unknown }).__diorama_page__ !== undefined
}

function bridgeOnSlotChange(
  ctx: Context,
  subscribe: (listener: () => void) => () => void,
): void {
  const page = (globalThis as unknown as { __diorama_page__?: PageBridge }).__diorama_page__
  if (page === undefined) throw new Error('slots: the page bridge is missing (load order: kernel bridge before pieces)')
  ctx.effect(
    () =>
      subscribe(() => {
        // Through the bridge's own method: this half's module copy is not the
        // shell's, and React/other callers may pass listeners detached.
        page.notify()
      }),
    'slots: page refresh',
  )
}
import type { SlotRegistry } from './registry.ts'
import { SlotRegistry as Registry } from './registry.ts'
import type { SlotComponent, SlotName, SlotRegistration, SlotSpec } from './types.ts'
import { createViews, type ViewsService } from './views.ts'

export const name = 'slots'


/** The `ctx.slots` face plugins see. */
export interface SlotsService {
  register<K extends SlotName>(registration: SlotRegistration<K>, component: SlotComponent<K>): () => void
  /**
   * Declare seats a plugin is about to register into (contract.md §3.3). A
   * plugin declares before it (or another plugin) registers, so an entry is
   * never held back waiting for a piece that has not run yet.
   */
  declare(seats: Partial<Record<SlotName, SlotSpec>>): void
}

declare module 'cordis' {
  interface Context {
    /** Register UI entries (contract.md §3.3). */
    slots: SlotsService
    /** Read-only slot observation (docs/m0/spec.md §3.2). */
    views: ViewsService
    /** The page handle `{ mountId, root, baseUrl, fs }` (docs/m0/spec.md §4). */
    mount: MountHandle
    /** The seat table, for chrome that renders slots without registering. */
    slotRegistry: SlotRegistry
    /** The kernel's page API (bridge notifications). */
    kernel: KernelPageApi
  }
}

export function apply(ctx: Context) {
  const registry = new Registry({ warn: message => ctx.logger.warn(message) })
  provideSlots(ctx, registry)
}

/** Provide `ctx.slots` / `ctx.views` on a client tree. */
export function provideSlots(ctx: Context, registry: SlotRegistry): void {
  const views = createViews(registry)
  ctx.provide('views', views)
  ctx.provide('slots', {
    register: (registration, component) => {
      // A stable, bound reference: entries run in their own build of this half,
      // where `registry.register` (a class method) may arrive detached.
      const dispose = registry.register(registration, component)
      return () => dispose()
    },
    declare: seats => registry.declare(seats),
  })
  // The seat table is reachable from the renderer, never from a plugin `ctx`:
  // components read it through the kernel context (`KernelContextValue.ctx`),
  // and page boot reads `ctx.views` from the root. (Cordis hides records
  // published on a per-plugin child context from every other context, and the
  // root's Proxy refuses names nobody provides, so a context record cannot
  // cross that boundary.) One client tree per page, so the module reference is
  // per page as well; a second, conflicting registry is refused loudly.
  // Published as a service (not a context record): Cordis hides records on a
  // plugin's child context from every other context, and services are how one
  // context hands a value to the rest of the tree.
  ctx.provide('slotRegistry', registry)
  // Every seat change re-renders the page. The renderer subscribes to the page
  // bridge (docs/m0/spec.md §10.3); that bridge is the shell's page global, so
  // register on it directly — this half's own build of the kernel module would
  // reach a different object. The same half also runs in the server tree, where
  // no page exists; there the subscription is skipped.
  if (pageBridgePresent()) bridgeOnSlotChange(ctx, listener => registry.subscribe(listener))
}

export { defaultSlotOrder, SlotConflictError, SlotRegistry, type SlotOrder } from './registry.ts'
export { BUILTIN_SLOTS, type FileRendererProps, type SlotKind, type SlotSpec } from './types.ts'
export type {
  MatchedSlotSpec,
  SlotComponent,
  SlotEntry,
  SlotMap,
  SlotName,
  SlotRegistration,
} from './types.ts'
export {
  chooseRenderer,
  PROBE_HEAD_BYTES,
  probeHead,
  RENDERER_SLOT,
  type RendererCandidate,
  type RendererChoice,
} from './select.ts'
export { createViews, type FailureInfo, type ViewsService } from './views.ts'
