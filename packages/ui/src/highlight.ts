/**
 * The page's syntax highlighter (contract.md §5.2: the diff readers).
 *
 * ## Why this is a page global, not a kernel service
 *
 * Highlighting a **diff row** is not the same job as highlighting a file. A
 * diff row comes from one of three places — the unified diff's own text, the
 * file with the changes laid into it, or the side-by-side reader's two columns
 * — and a reader must highlight each row **on its own**, because the rows are
 * drawn separately (folded runs, gutters, blank cells on one side).
 *
 * The engine that knows the languages is the `code` piece (highlight.js, with
 * one registration list). `git-changes` cannot import it — every client half
 * is its own build (docs/m0/spec.md §10.3), so an import would be a second
 * copy of the engine in a second bundle — and it must not ask the kernel
 * either: "how is this file coloured" is page UI state, exactly like the
 * reveal store and the overlay store (docs/m4/spec.md §6.2 trap 13).
 *
 * So the `code` half **publishes** an engine here, once, at boot, and the diff
 * readers read it off the page. The store is versioned so a reader that
 * renders before the publisher (boot order is the graph's, not this file's)
 * repaints when it arrives.
 *
 * ## What an engine must do
 *
 * Only two things, and both are pure:
 *
 * - {@link Highlighter.languageOf} — the language a path is read as, so a
 *   caller can show it (and so "no language" is a fact, not a guess);
 * - {@link Highlighter.lines} — one text as **HTML per line**, each line a
 *   self-contained fragment (the caller draws one row per element, so a span
 *   must not leak across a line break).
 *
 * The contract is deliberately about *lines*, not about a document: that is
 * the shape every diff reader needs, and it is what keeps a two-column reader
 * from having to re-highlight a whole file twice.
 */

import { useSyncExternalStore } from 'react'

/** One engine's language for a path (`plaintext` when there is none). */
export interface Highlighter {
  /** The language a file is highlighted as; `plaintext` means "not one". */
  languageOf(path: string): string
  /**
   * One text as HTML, one entry per line: `lines[i]` is line `i + 1`.
   *
   * Every entry is complete on its own (spans opened on that line are closed
   * on it), so a caller may draw any subset of the lines, in any order, and
   * still get well-formed markup. An empty text has no lines (`[]`).
   */
  lines(text: string, path: string): string[]
}

/** The published engine, its version, and who is watching (one per page). */
interface HighlightState {
  engine: Highlighter | undefined
  /** Bumped on every publish/dispose: `useSyncExternalStore` reads a number. */
  version: number
  listeners: Set<() => void>
}

/**
 * The page global. The key is a literal on purpose: every client half bundles
 * its own copy of this module, so only `globalThis` is shared between them
 * (the same rule as `__diorama_page__`, `__diorama_reveal__`,
 * `__diorama_overlay__`).
 */
interface HighlightScope {
  __diorama_highlight__?: HighlightState
}

function state(): HighlightState {
  const page = globalThis as unknown as HighlightScope
  page.__diorama_highlight__ ??= { engine: undefined, version: 0, listeners: new Set() }
  return page.__diorama_highlight__
}

/**
 * Publish an engine for every piece of this page. Returns the disposer: a
 * piece that unloads must not leave a dead engine behind (the next piece to
 * publish would then be shadowed by it).
 */
export function publishHighlighter(engine: Highlighter): () => void {
  const current = state()
  current.engine = engine
  notify(current)
  return () => {
    // Only clear what this publisher put there: another piece may have
    // published since, and its engine is the live one.
    if (current.engine !== engine) return
    current.engine = undefined
    notify(current)
  }
}

/** The engine right now (`undefined` before the publisher boots, or after it goes). */
export function highlighter(): Highlighter | undefined {
  return state().engine
}

/**
 * The store surface a component hands to `useSyncExternalStore`: a bound
 * `subscribe` plus a **primitive** snapshot, so React never sees a fresh
 * object on every read (the "re-renders forever" trap).
 */
export const highlighterStore = {
  subscribe(listener: () => void): () => void {
    const current = state()
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
    }
  },
  /** A version number: it changes when the engine does, and compares by value. */
  getSnapshot(): number {
    return state().version
  },
}

/**
 * The engine, as a component reads it: it repaints when a piece publishes
 * one after this component's first render (the boot order is the plugin
 * graph's, not this module's).
 */
export function useHighlighter(): Highlighter | undefined {
  // The version is what re-renders us; the engine itself is read after it.
  useSyncExternalStore(highlighterStore.subscribe, highlighterStore.getSnapshot, highlighterStore.getSnapshot)
  return state().engine
}

function notify(current: HighlightState): void {
  current.version += 1
  // Copy first: a listener may publish or dispose while we iterate.
  for (const listener of [...current.listeners]) listener()
}
