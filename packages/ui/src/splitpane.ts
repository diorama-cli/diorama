/**
 * A pane edge the reader can drag (contract.md §5.2).
 *
 * Two panes have a width of their own that the reader may want to change: the
 * left column of the frame (`layout`) and the file list of a commit
 * (`git-changes`). The gesture is one gesture, so both are built from this
 * module instead of each growing its own pointer handling — that is also what
 * keeps a *new* pane from inventing a third set of bounds and keys:
 *
 * - {@link Splitter} (in `splitpane.tsx`) is the separator itself: a narrow
 *   strip with `role="separator"` that is dragged with the pointer, or moved
 *   with the arrow keys once it has focus (16px a press, Shift for 64px, Home /
 *   End to the bounds). A pane that must be readable at any width gets one of
 *   these, not a fixed pixel value.
 * - {@link usePaneSize} is the width it moves, remembered in `localStorage`
 *   the way the theme and the diff mode are: it is a **preference**, not page
 *   state, and a blocked storage only means it does not survive a reload.
 *
 * While the pointer is down only `onPreview` runs — the caller writes the CSS
 * variable straight onto its element. Committing every pointer move to React
 * state would re-render the pane's whole contents (a file tree can be hundreds
 * of rows) on every frame; the state changes once, when the gesture ends.
 */
import { useCallback, useState } from 'react'

/** Narrowest a resizable pane may be made (px). */
export const MIN_PANE_PX = 160

/** Widest a resizable pane may be made (px). */
export const MAX_PANE_PX = 720

/** What one arrow-key press moves the edge (px). */
export const PANE_STEP_PX = 16

/**
 * A width the reader asked for, kept inside the pane's own bounds.
 *
 * `fallback` is what a page with no stored preference (or an unreadable one)
 * starts at; a stored value outside the bounds is clamped rather than
 * discarded, so a window that shrank since last time does not lose the
 * preference.
 */
export function clampPane(width: number, min = MIN_PANE_PX, max = MAX_PANE_PX): number {
  // A gesture that produced no number at all (a cancelled pointer, a NaN from
  // arithmetic on an unset property) must not become a NaN width: the pane
  // keeps its narrowest size instead of collapsing.
  if (Number.isNaN(width)) return min
  return Math.min(max, Math.max(min, Math.round(width)))
}

/** The stored width for `key`, or `fallback` when there is none. */
export function readPaneSize(key: string, fallback: number, min = MIN_PANE_PX, max = MAX_PANE_PX): number {
  try {
    const stored = globalThis.localStorage?.getItem(key)
    if (stored === null || stored === undefined) return clampPane(fallback, min, max)
    const parsed = Number.parseFloat(stored)
    return Number.isFinite(parsed) ? clampPane(parsed, min, max) : clampPane(fallback, min, max)
  } catch {
    return clampPane(fallback, min, max)
  }
}

/** Remember `size`. A blocked storage just means the width is not remembered. */
export function storePaneSize(key: string, size: number): void {
  try {
    globalThis.localStorage?.setItem(key, String(size))
  } catch {
    // Nothing to do: the width still applies to this page.
  }
}

/**
 * The width of one pane, as React state. The setter clamps and remembers; the
 * preview path of a drag bypasses it (see the module comment).
 */
export function usePaneSize(
  key: string,
  fallback: number,
  min = MIN_PANE_PX,
  max = MAX_PANE_PX,
): [number, (next: number) => void] {
  const [size, setSize] = useState(() => readPaneSize(key, fallback, min, max))
  const commit = useCallback(
    (next: number) => {
      setSize(current => {
        const clamped = clampPane(next, min, max)
        if (clamped !== current) storePaneSize(key, clamped)
        return clamped
      })
    },
    [key, min, max],
  )
  return [size, commit]
}
