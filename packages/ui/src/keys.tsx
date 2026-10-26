/**
 * Shortcut hints on the page's controls (contract.md §3.7, v0.15).
 *
 * While the reader holds ⌘ / Ctrl (or Option / Alt) every control that has a
 * command shows that command's key beside itself — the tab strip, the activity
 * bar's view icons, the fold button. Release the modifier and the hints go.
 * That is the "hold ⌘ and look" gesture of an editor (and of cmux): it answers
 * "what can I press here?" without leaving the page for a shortcut sheet.
 *
 * Two pieces:
 *
 * - `useHeldModifier` reads the page-global hold state the kernel keeps up to
 *   date (it owns the page's only `keydown` listener). It is a page global for
 *   the same reason as the overlay and reveal stores: each client half is its
 *   own build, so a module object would be one copy per half.
 * - `KeyHint` draws one chip, or nothing. `label` is **already formatted** —
 *   the kernel's registry publishes `⌘⌥W` / `Ctrl+Alt+W` next to each binding
 *   (`CommandsSnapshot.bindings[].label`), so no half has to know the notation.
 *
 * The chip is decoration: it is `aria-hidden` and carries no accessible name,
 * because the button it sits in already has one, and a screen reader reading
 * "⌘⌥W" after the button's label is noise rather than help.
 */
import { useSyncExternalStore } from 'react'

/**
 * The page-global hold store (written by the kernel, read here). Only two
 * methods are required — the kernel's `__diorama_keys__` object is exactly
 * that — and they are called through it, never detached.
 */
interface HeldScope {
  __diorama_keys__?: {
    subscribe(listener: () => void): () => void
    getSnapshot(): string
  }
}

/** Subscribe to the page's hold state (a stable function: React may call it detached). */
function subscribeHeld(listener: () => void): () => void {
  const store = (globalThis as unknown as HeldScope).__diorama_keys__
  return store === undefined ? () => {} : store.subscribe(listener)
}

/** `''` / `'mod'` / `'alt'` — a string, so React compares snapshots by value. */
function heldSnapshot(): string {
  const store = (globalThis as unknown as HeldScope).__diorama_keys__
  return store === undefined ? '' : store.getSnapshot()
}

/**
 * The modifier held right now: `'mod'` (⌘ / Ctrl), `'alt'` (Option / Alt) or
 * `undefined`. Re-renders the component when the hold starts and ends.
 *
 * A page with no kernel listener installed (a unit test, a host that booted
 * the tree itself) answers `undefined` — no hints, never a crash.
 */
export function useHeldModifier(): 'mod' | 'alt' | undefined {
  const snapshot = useSyncExternalStore(subscribeHeld, heldSnapshot, heldSnapshot)
  return snapshot === 'mod' || snapshot === 'alt' ? snapshot : undefined
}

export interface KeyHintProps {
  /** The shortcut, already formatted by the page's registry (`⌘⌥W`). */
  label: string | undefined
  /** The canonical binding (`mod+alt+w`), for tests and for a tooltip. */
  keys?: string | undefined
  /** Whether the reader is holding a modifier (see {@link useHeldModifier}). */
  held: 'mod' | 'alt' | undefined
}

/**
 * One shortcut chip: nothing at all unless a modifier is held and the command
 * has a binding. Rendered as a `<kbd>` so it reads like a key wherever it
 * lands, and marked with `data-keys` so a test can tell which binding a
 * particular control advertises.
 *
 * **Either** hold reveals the hints (⌘ / Ctrl *and* Option / Alt): the page's
 * bindings use both families (`⌘⌥W`, `⌥1`, `⇧?`), so "hold a modifier and
 * look" must answer for whichever one the reader reached for.
 */
export function KeyHint({ label, keys, held }: KeyHintProps) {
  // The chip is mounted whenever the control has a binding — a button may
  // reserve its slot in CSS (the close button swaps its ✕ for the chip) — and
  // filled only while a modifier is held.
  if (label === undefined || label === '') return null
  return held === undefined ? null : (
    <kbd className="diorama-keyhint" data-testid="key-hint" data-keys={keys ?? label} aria-hidden="true">
      {label}
    </kbd>
  )
}
