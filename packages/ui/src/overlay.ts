/**
 * Which overlay is open (contract.md §5, `layout.overlay`).
 *
 * `layout.overlay` is a **list** seat since v0.7: the palette and the shortcut
 * sheet are separate pieces, and only one of them may be up at a time. They
 * cannot coordinate by importing each other — each client half is its own
 * build, so a module-level object would be one copy per half — and they must
 * not coordinate through a kernel service either, because "which panel is up"
 * is page UI state that the kernel has no business owning.
 *
 * The page's `globalThis` is the one place every half sees the same object
 * (same reason as `__diorama_page__` and `__diorama_layout__`). A piece calls
 * {@link showOverlay} with its own id; the store answers whether that id is the
 * open one, and every other overlay closes as a side effect.
 */

/** One overlay's open/closed flag, kept per page. */
interface OverlayState {
  /** The id of the open overlay, if any (one at a time). */
  open: string | undefined
  listeners: Set<() => void>
}

/**
 * The page global. The key is a literal on purpose: every client half bundles
 * its own copy of this module, so only `globalThis` is shared between them.
 */
interface OverlayScope {
  __diorama_overlay__?: OverlayState
}

function state(): OverlayState {
  const page = globalThis as unknown as OverlayScope
  page.__diorama_overlay__ ??= { open: undefined, listeners: new Set() }
  return page.__diorama_overlay__
}

/**
 * Open `id` and close whatever else was open (opening the open one is a
 * no-op). Readers subscribe through {@link overlayStore}.
 */
export function showOverlay(id: string): void {
  const current = state()
  if (current.open === id) return
  current.open = id
  notify(current)
}

/** Close the overlay named `id`; another overlay being open is left alone. */
export function hideOverlay(id: string): void {
  const current = state()
  if (current.open !== id) return
  current.open = undefined
  notify(current)
}

/** Close whichever overlay is open (used by Escape on the overlay itself). */
export function closeOverlay(): void {
  const current = state()
  if (current.open === undefined) return
  current.open = undefined
  notify(current)
}

/** Whether `id` is the overlay that is up right now. */
export function overlayOpen(id: string): boolean {
  return state().open === id
}

/** Toggle one overlay: opening it closes the others. */
export function toggleOverlay(id: string): void {
  if (overlayOpen(id)) hideOverlay(id)
  else showOverlay(id)
}

/**
 * The store surface a component hands to `useSyncExternalStore`: a **bound**
 * `subscribe` plus a snapshot that is a primitive, so React never sees a fresh
 * object on every read (the "re-renders forever" trap).
 */
export const overlayStore = {
  subscribe(listener: () => void): () => void {
    const current = state()
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
    }
  },
  /** The id of the open overlay (or `undefined`): a stable, comparable value. */
  getSnapshot(): string | undefined {
    return state().open
  },
}

function notify(current: OverlayState): void {
  // Copy first: a listener may close another overlay while we iterate.
  for (const listener of [...current.listeners]) listener()
}
