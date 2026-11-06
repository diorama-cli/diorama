/**
 * Whether this page has a **navigation piece**, and what it wants
 * (contract.md §3.12, §8).
 *
 * The text renderers (`code`, `plaintext`) and the navigation piece are separate
 * builds: neither can import the other, and a build without the piece must
 * draw exactly what it drew before. So the piece publishes a small face here
 * and the renderer asks whether anyone is listening — the same page-global
 * pattern as `__diorama_highlight__` (contract §8).
 *
 * The face is deliberately thin. **The renderer owns the caret** (it owns the
 * rows, the gutter and the line model), so the piece cannot ask "what is under
 * the pointer?" — it can only say "I am here, and here is what I offer". The
 * renderer turns its own DOM into a line and column and then asks
 * `mountCtx.lsp` itself (§3.12).
 */
import { useSyncExternalStore } from 'react'

/** What a navigation piece offers the renderer. */
export interface LspNav {
  /** Draw the hover card when the pointer rests on a symbol. */
  hover: boolean
  /** Add "find references" to the row's context menu. */
  references: boolean
}

/** What a page without the piece has: nothing to wire. */
export const NO_LSP_NAV: LspNav = { hover: false, references: false }

/** The page-global record (one per page, never per half). */
interface NavState {
  current: LspNav | undefined
  listeners: Set<() => void>
  version: number
}

interface NavScope {
  [NAV_KEY]?: NavState
}

/** The property every half of the page agrees on. */
const NAV_KEY = '__diorama_lsp_nav__' as const

function state(): NavState {
  const page = globalThis as unknown as NavScope
  page[NAV_KEY] ??= { current: undefined, listeners: new Set(), version: 0 }
  return page[NAV_KEY]
}

function notify(current: NavState): void {
  current.version++
  for (const listener of [...current.listeners]) listener()
}

/**
 * Publish the face (the navigation piece calls this). Returns the
 * unsubscriber; disposing the piece leaves the renderer with no gestures,
 * which is the page a build without the piece has.
 */
export function publishLspNav(nav: LspNav): () => void {
  const current = state()
  current.current = nav
  notify(current)
  return () => {
    if (current.current !== nav) return
    current.current = undefined
    notify(current)
  }
}

/** The current face, if any (a plain read; not a hook). */
export function lspNav(): LspNav | undefined {
  return state().current
}

/** The store surface for `useSyncExternalStore` (a version number, not an object). */
export function lspNavStore(): { subscribe(listener: () => void): () => void; getVersion(): number } {
  return {
    subscribe(listener) {
      const current = state()
      current.listeners.add(listener)
      return () => {
        current.listeners.delete(listener)
      }
    },
    getVersion: () => state().version,
  }
}

/** The face this page has, or `undefined` when no piece published one. */
export function useLspNav(): LspNav | undefined {
  const store = lspNavStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return lspNav()
}
