/**
 * The page bridge (docs/m0/spec.md §10.3).
 *
 * One page = one bridge object on `globalThis.__diorama_page__`. The shell
 * installs its kernel through it; the renderer (inlined into the shell) and
 * every client half (their own builds) read page state through it.
 *
 * The bridge exposes **methods only** — `getKernel`, `getVersion`, `subscribe`
 * — and every caller invokes them *through* the object. React may invoke a
 * `subscribe` reference without its receiver, and an inlined copy of a state
 * object is not the state object; a method closed over this bridge is immune to
 * both.
 */
import type { Context } from 'cordis'
import type { MountHandle } from './mount.ts'

/**
 * Read-only view of the seat table: every registered entry of a seat. The
 * `slots` piece provides the registry; the kernel publishes it here so a
 * component that declares a seat can read it back (the dispatcher needs the
 * entries of the seat it draws, contract.md §5).
 */
export interface KernelSlotRegistry {
  /** Changes on every registration or removal. */
  readonly version: number
  entriesOf(name: string, key?: string): readonly unknown[]
  /** Every entry of every seat, in total order (dispatcher seats). */
  all(): readonly unknown[]
  /** Whether the piece that declares a seat is in this page (contract.md §3.3). */
  owned(name: string): boolean
}

/** What components need from the page: services plus the mount handle. */
export interface KernelContextValue {
  /** Read-only slot observation (entries, failures). */
  views: KernelViews
  /** The seat table (optional: absent only when the boot graph has no `slots`). */
  registry?: KernelSlotRegistry
  /** The page's Cordis context, for services other pieces provide. */
  ctx: Context
  /** The page handle (`mountCtx`). */
  mount: MountHandle
}

/** The slice of `ctx.views` the renderer uses. */
export interface KernelViews {
  subscribe(listener: () => void): () => void
  entries(name: never, key?: string): readonly unknown[]
  failed(id: string): boolean
  failure(id: string): { error: unknown } | undefined
  reportFailure(id: string, error: unknown): void
}

/**
 * What the kernel offers the client tree beyond the handle: republish
 * renderer-visible state. Provided as `ctx.kernel` on the root so pieces never
 * depend on this module's identity for it.
 */
export interface KernelPageApi {
  /** Republish renderer-visible state (the page re-renders). */
  refresh(): void
  /** Republish on every change of a piece-owned store. */
  onSlotChange(subscribe: (listener: () => void) => () => void): void
}

/** The page bridge face (what `globalThis.__diorama_page__` is). */
export interface PageBridge {
  getKernel(): KernelContextValue | undefined
  getVersion(): number
  subscribe(listener: () => void): () => void
  /** Install the page kernel (the shell calls this once per page). */
  install(kernel: KernelContextValue): void
  /** Bump the version and notify (renderer-visible state changed). */
  notify(): void
}

const BRIDGE_KEY = '__diorama_page__'

/**
 * Create the page bridge. Idempotent per page: if one exists, it is returned
 * (the shell installs it; a half may create it first only in tests).
 */
export function ensurePageBridge(): PageBridge {
  const scope = globalThis as unknown as Record<string, PageBridge | undefined>
  const existing = scope[BRIDGE_KEY]
  if (existing !== undefined) return existing

  let kernel: KernelContextValue | undefined
  let version = 0
  const listeners = new Set<() => void>()

  const bridge: PageBridge = {
    getKernel: () => kernel,
    getVersion: () => version,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    install(value) {
      if (kernel !== undefined) throw new Error('diorama kernel: a page kernel is already installed')
      kernel = value
      bridge.notify()
    },
    notify() {
      version++
      for (const listener of [...listeners]) listener()
    },
  }
  Object.defineProperty(globalThis, BRIDGE_KEY, { value: bridge, configurable: true })
  return bridge
}

/** The page bridge. Throws outside a booted page. */
export function pageBridge(): PageBridge {
  const bridge = (globalThis as unknown as Record<string, PageBridge | undefined>)[BRIDGE_KEY]
  if (bridge === undefined) throw new Error('diorama kernel: no page is booted')
  return bridge
}

/** Install the page kernel (the shell calls this once per page). */
export function installKernel(value: KernelContextValue): void {
  ensurePageBridge().install(value)
}

/** Read the page kernel. Throws when no page has installed one. */
export function getKernel(): KernelContextValue {
  const kernel = pageBridge().getKernel()
  if (kernel === undefined) throw new Error('diorama kernel: no page kernel is installed')
  return kernel
}

/** Mark renderer-visible page state as changed. */
export function notifyKernel(): void {
  pageBridge().notify()
}

/** Snapshot for `useSyncExternalStore`: stable between notifications. */
export function kernelVersion(): number {
  return pageBridge().getVersion()
}

/** Subscribe to page-state changes; returns the unsubscriber. */
export function subscribeKernel(listener: () => void): () => void {
  return pageBridge().subscribe(listener)
}
