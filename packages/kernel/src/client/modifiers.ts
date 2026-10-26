/**
 * Which modifier the reader is holding down (contract.md §3.7, v0.15).
 *
 * The page shows every control's shortcut while a modifier is held — the way
 * an editor (and cmux) does: press ⌘ and the tab strip, the activity bar and
 * the fold button each show their key; release it and the hints go. Nothing is
 * *run* by holding a modifier; this is a display state and nothing else.
 *
 * It lives on the page global for the same reason the overlay and reveal stores
 * do: each client half is its own build (docs/m0/spec.md §10.3), so a
 * module-level object would be one copy per half. The kernel is the half that
 * sees every key (it owns the page's single `keydown` listener), so it is the
 * one that keeps this state up to date; a piece reads it through
 * `diorama-ui`'s `useHeldModifier`, which needs nothing but the store's two
 * methods.
 *
 * The snapshot is a **string** (`''` / `'mod'` / `'alt'`), never an object:
 * `useSyncExternalStore` compares snapshots by value, and a fresh object on
 * every read re-renders forever (the trap every store here avoids). The
 * methods are written so they work **detached** — React hands
 * `subscribe` to the store without its receiver.
 */

/** The two hold gestures: ⌘ / Ctrl, and Option / Alt. */
export type HeldModifier = 'mod' | 'alt'

/**
 * The page-global hold store: the current modifier (`''` when none) and who is
 * watching. One object, because `diorama-ui` reads exactly these two methods
 * off `globalThis.__diorama_keys__`.
 */
interface KeysState {
  held: HeldModifier | undefined
  listeners: Set<() => void>
}

/** The page global. The key is a literal on purpose (see the module comment). */
interface KeysScope {
  __diorama_keys__?: KeysState & {
    subscribe(listener: () => void): () => void
    getSnapshot(): string
  }
}

function state(): NonNullable<KeysScope['__diorama_keys__']> {
  const page = globalThis as unknown as KeysScope
  page.__diorama_keys__ ??= {
    held: undefined,
    listeners: new Set(),
    // Bound through `this`-free closures so a detached call still works.
    subscribe(listener: () => void): () => void {
      const current = state()
      current.listeners.add(listener)
      return () => {
        current.listeners.delete(listener)
      }
    },
    getSnapshot(): string {
      return state().held ?? ''
    },
  }
  return page.__diorama_keys__
}

/**
 * Create the page-global store now. A component subscribes to it at its first
 * render, and a store that does not exist yet cannot be subscribed to: the
 * kernel calls this once at boot, before any piece renders, so every
 * `useHeldModifier` finds the same object.
 */
export function ensureHeldModifierStore(): void {
  state()
}

/** The modifier held right now (`undefined` when none is). */
export function heldModifier(): HeldModifier | undefined {
  return state().held
}

/**
 * Record the modifier held right now. Repeating the same value is a no-op, so
 * a reader holding ⌘ through a whole sequence of keystrokes re-renders the
 * page once, not once per key.
 */
export function holdModifier(held: HeldModifier | undefined): void {
  const current = state()
  if (current.held === held) return
  current.held = held
  // Copy first: a listener may unsubscribe while we iterate.
  for (const listener of [...current.listeners]) listener()
}

/**
 * The store surface, for a caller that wants the two methods in one place (the
 * page global holds the same object; `diorama-ui` reads it from there).
 */
export const heldModifierStore = {
  subscribe(listener: () => void): () => void {
    return state().subscribe(listener)
  },
  /** `''` / `'mod'` / `'alt'`: a string, so React compares by value. */
  getSnapshot(): string {
    return state().getSnapshot()
  },
}
