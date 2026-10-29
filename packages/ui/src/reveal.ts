/**
 * "Show this line" — the page-global reveal store (contract.md §3.9).
 *
 * A search result is a (path, line) pair, and opening the file is not enough:
 * the reader has to land on the line. Tabs carry a path only (contract.md
 * §3.4), so the line travels beside them: the search piece calls
 * {@link reveal}, the renderer that draws the file asks {@link useReveal} and
 * scrolls its own text there.
 *
 * Since v0.19 the target is a **range** (`src/app.ts:42-60`) and may ask for a
 * **flash** — a band that fades once, for "take me to line 42", as opposed to
 * the steady band a search hit leaves behind (§3.11).
 *
 * Page state, not a kernel service — the same reason as `overlay` and
 * `__diorama_layout__`: every client half is its own build, so a module-level
 * object would be one copy per half, and "where the reader is looking inside a
 * file" is not a service other pieces should depend on. The page's
 * `globalThis` is the one place they all see.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { clampTarget } from './line-numbers.ts'

/** Where the reader was sent: a file and a 1-based line range (inclusive). */
export interface RevealTarget {
  path: string
  /** First line of the range (1-based). */
  line: number
  /** Last line of the range; equal to `line` for a single line. */
  endLine: number
  /** 1-based column of the match; absent for "just this line". */
  column?: number
  /** Characters matched, for a renderer that wants to mark them. */
  length?: number
  /** Fade the band once (a "go to line") instead of leaving it up (a hit). */
  flash: boolean
  /** Monotonic stamp: asking for the same line twice reveals it twice. */
  at: number
}

interface RevealState {
  target: RevealTarget | undefined
  listeners: Set<() => void>
  stamp: number
}

/** The page global (see the module comment). */
interface RevealScope {
  __diorama_reveal__?: RevealState
}

function state(): RevealState {
  const page = globalThis as unknown as RevealScope
  page.__diorama_reveal__ ??= { target: undefined, listeners: new Set(), stamp: 0 }
  return page.__diorama_reveal__
}

function notify(current: RevealState): void {
  for (const listener of [...current.listeners]) listener()
}

/** What a caller may ask of {@link reveal}. */
export interface RevealOptions {
  /** Last line of a range; absent means "this line only". */
  endLine?: number
  /** 1-based column of the match. */
  column?: number
  /** Characters matched. */
  length?: number
  /** Fade once instead of staying up (default: stay, the search-hit behaviour). */
  flash?: boolean
}

/**
 * Send the reader to a line (or a range) of one file; opening the file is the
 * caller's job. A range is normalised (the smaller line first) and never
 * empty, so a renderer can draw it without checking.
 */
export function reveal(path: string, line: number, options: RevealOptions = {}): void {
  const current = state()
  const first = Math.max(1, Math.floor(line))
  const last = options.endLine === undefined ? first : Math.max(1, Math.floor(options.endLine))
  current.stamp++
  current.target = {
    path,
    line: Math.min(first, last),
    endLine: Math.max(first, last),
    ...(options.column === undefined ? {} : { column: options.column }),
    ...(options.length === undefined ? {} : { length: options.length }),
    flash: options.flash === true,
    at: current.stamp,
  }
  notify(current)
}

/** Forget the current target (the renderer keeps what it drew). */
export function clearReveal(): void {
  const current = state()
  if (current.target === undefined) return
  current.target = undefined
  notify(current)
}

/** The store surface for `useSyncExternalStore` (a primitive snapshot). */
export const revealStore = {
  subscribe(listener: () => void): () => void {
    const current = state()
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
    }
  },
  /** The stamp: a number, so React never sees a fresh object on every read. */
  getSnapshot(): number {
    return state().stamp
  },
}

/**
 * The reveal target for one file, if the reader was sent there. Re-renders on
 * every reveal; a target for another file is not returned (a background tab
 * must not scroll itself because a result in another file was opened).
 */
export function useReveal(path: string | undefined): RevealTarget | undefined {
  useSyncExternalStore(revealStore.subscribe, revealStore.getSnapshot, revealStore.getSnapshot)
  const target = state().target
  if (target === undefined || path === undefined || target.path !== path) return undefined
  return target
}

/** What a renderer draws for a revealed range: lines `line`…`endLine`. */
export interface RevealedLine {
  line: number
  /** Last line of the range (equal to `line` for one line). */
  endLine: number
  /** `true` for a one-shot flash ("go to line"), `false` for a steady band. */
  flash: boolean
  /** 1-based column of the match, when the caller knew one. */
  column?: number
  /** Characters matched, when the caller knew them. */
  length?: number
  /** The stamp of the request (a new value = a new request). */
  at: number
}

/**
 * Follow the reveal store inside a renderer: reports the range to draw and
 * asks the caller to scroll to it.
 *
 * The renderer supplies `focus(line)`: it knows how its text is laid out (the
 * text renderers draw one element per line, so the line is found, not
 * measured — docs/m19/spec.md §6). The hook only decides *when*.
 *
 * `count` is the file's line count when the renderer knows it: the target is
 * then clamped into the file, so `:999` in a ten-line file lands on line 10
 * instead of pointing at nothing (§3.11).
 */
export function useRevealLine(
  path: string | undefined,
  focus: (line: number) => void,
  count?: number,
): RevealedLine | undefined {
  const target = useReveal(path)
  const stamp = target?.at
  const raw = target === undefined ? undefined : clampTarget({ start: target.line, end: target.endLine }, count ?? Number.MAX_SAFE_INTEGER)
  const line = raw?.start
  const endLine = raw?.end
  const flash = target?.flash
  const column = target?.column
  const length = target?.length
  // The callback is read through a ref: a renderer passes an inline function,
  // and a fresh identity every render must not re-run the scroll. The ref is
  // refreshed in its own effect (declared first, so it has already run when the
  // scroll effect below looks at it in the same commit).
  const focusRef = useRef(focus)
  useEffect(() => {
    focusRef.current = focus
  })
  useEffect(() => {
    if (line === undefined) return
    focusRef.current(line)
  }, [stamp, line])
  if (line === undefined || endLine === undefined) return undefined
  return {
    line,
    endLine,
    flash: flash === true,
    ...(column === undefined ? {} : { column }),
    ...(length === undefined ? {} : { length }),
    at: stamp ?? 0,
  }
}
