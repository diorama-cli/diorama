/**
 * "Show this line" — the page-global reveal store (contract.md §3.9).
 *
 * A search result is a (path, line) pair, and opening the file is not enough:
 * the reader has to land on the line. Tabs carry a path only (contract.md
 * §3.4), so the line travels beside them: the search piece calls
 * {@link reveal}, the renderer that draws the file asks {@link useRevealLine}
 * and scrolls its own `<pre>` there.
 *
 * Page state, not a kernel service — the same reason as `overlay` and
 * `__diorama_layout__`: every client half is its own build, so a module-level
 * object would be one copy per half, and "where the reader is looking inside a
 * file" is not a service other pieces should depend on. The page's
 * `globalThis` is the one place they all see.
 */
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'

/** Where the reader was sent: a file and a 1-based line. */
export interface RevealTarget {
  path: string
  line: number
  /** 1-based column of the match; absent for "just this line". */
  column?: number
  /** Characters matched, for a renderer that wants to mark them. */
  length?: number
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

/** Send the reader to one line of one file (opening the file is the caller's job). */
export function reveal(path: string, line: number, column?: number, length?: number): void {
  const current = state()
  current.stamp++
  current.target = {
    path,
    line: Math.max(1, Math.floor(line)),
    ...(column === undefined ? {} : { column }),
    ...(length === undefined ? {} : { length }),
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

/** What a renderer draws for a revealed line: a band at `top` px, `height` px tall. */
export interface RevealedLine {
  line: number
  top: number
  height: number
}

/**
 * Follow the reveal store inside a renderer: scrolls the element's scroller so
 * the line sits in the middle, and reports where to draw the band.
 *
 * The element must lay its text out with `white-space: pre` and one line height
 * for every line (both built-in text renderers do), which is what makes
 * `line × lineHeight` the line's position without measuring each line.
 */
export function useRevealLine(path: string | undefined, ref: RefObject<HTMLElement | null>): RevealedLine | undefined {
  const target = useReveal(path)
  const [shown, setShown] = useState<RevealedLine | undefined>(undefined)
  const stamp = target?.at
  const line = target?.line
  useEffect(() => {
    if (line === undefined) {
      setShown(undefined)
      return
    }
    const element = ref.current
    if (element === null) return
    const style = getComputedStyle(element)
    const height = lineHeightOf(style)
    if (height <= 0) return
    const top = (line - 1) * height + (Number.parseFloat(style.paddingTop) || 0)
    const scroller = scrollParent(element)
    const base = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTop = Math.max(0, base + top - scroller.clientHeight / 2 + height / 2)
    setShown({ line, top, height })
  }, [stamp, line, ref])
  return shown
}

/** A computed line height in px (`normal` is measured by the font's own metrics). */
function lineHeightOf(style: CSSStyleDeclaration): number {
  const declared = Number.parseFloat(style.lineHeight)
  if (Number.isFinite(declared) && declared > 0) return declared
  const fontSize = Number.parseFloat(style.fontSize)
  return Number.isFinite(fontSize) ? fontSize * 1.5 : 0
}

/** The nearest ancestor that scrolls vertically (the tab pane, in practice). */
function scrollParent(element: HTMLElement): HTMLElement {
  let current = element.parentElement
  while (current !== null) {
    const overflow = getComputedStyle(current).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return current
    current = current.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}
