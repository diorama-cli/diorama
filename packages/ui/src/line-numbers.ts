/**
 * Line numbers, and the `:line` suffix (contract.md §3.11).
 *
 * Two things that look unrelated and are one idea: the text renderers can
 * **show a gutter of line numbers**, and every surface that can name a file can
 * also name a line (`src/app.ts:42`, `:42-60`). The gutter is the coordinate
 * system the suffix addresses, so they are decided together.
 *
 * Page state, not a kernel service — the same reason as `overlay` and
 * `reveal`: every client half is its own build, so a module-level object would
 * be one copy per half, while `code` and `plaintext` (two halves) and the
 * palette (a third) must agree on one answer. The page's `globalThis` is the
 * one place they all see.
 *
 * The preference is remembered in `localStorage` (`diorama.lineNumbers`), like
 * the sidebar's folded state and the diff reader's mode. `0` / `1` only: a
 * reader who has never chosen gets the default (on).
 *
 * No React, no DOM: `node --test` loads this file directly (the store's host
 * is read at call time, so a test may install its own `localStorage`).
 */

/** Where the choice is remembered between reloads. */
export const LINE_NUMBERS_STORAGE_KEY = 'diorama.lineNumbers'

/** Nobody has chosen yet: show the gutter (an editor's own default). */
export const LINE_NUMBERS_DEFAULT = true

/** The glyph the renderer headers and the palette row use (contract.md §3.11). */
export const LINE_NUMBERS_ICON = 'line-numbers'

/** The command the palette runs (contract.md §3.7); the headers' buttons run the same store. */
export const LINE_NUMBER_TOGGLE_COMMAND = 'view.toggleLineNumbers'

/** What the command is called. */
export const LINE_NUMBER_TOGGLE_TITLE = '显示 / 隐藏行号'

interface LineNumbersState {
  shown: boolean
  listeners: Set<() => void>
}

/** The page global (see the module comment). */
interface LineNumbersScope {
  __diorama_line_numbers__?: LineNumbersState
}

function state(): LineNumbersState {
  const page = globalThis as unknown as LineNumbersScope
  const existing = page.__diorama_line_numbers__
  if (existing !== undefined) return existing
  const created: LineNumbersState = { shown: readStored() ?? LINE_NUMBERS_DEFAULT, listeners: new Set() }
  page.__diorama_line_numbers__ = created
  return created
}

/** The remembered choice; `undefined` when nobody chose or storage is blocked. */
function readStored(): boolean | undefined {
  try {
    const value = globalThis.localStorage?.getItem(LINE_NUMBERS_STORAGE_KEY)
    if (value === '1') return true
    if (value === '0') return false
    return undefined
  } catch {
    // A blocked storage (private mode, a sandboxed frame) is not an error: the
    // choice just does not survive a reload.
    return undefined
  }
}

function store(shown: boolean): void {
  try {
    globalThis.localStorage?.setItem(LINE_NUMBERS_STORAGE_KEY, shown ? '1' : '0')
  } catch {
    // Same as above: remember nothing rather than break the page.
  }
}

function notify(current: LineNumbersState): void {
  for (const listener of [...current.listeners]) listener()
}

/** Whether the gutter is drawn right now. */
export function lineNumbersShown(): boolean {
  return state().shown
}

/** Show or hide the gutter, and remember the choice. */
export function setLineNumbers(shown: boolean): void {
  const current = state()
  store(shown)
  if (current.shown === shown) return
  current.shown = shown
  notify(current)
}

/** Flip the gutter; returns the new state (what the command reports). */
export function toggleLineNumbers(): boolean {
  const next = !lineNumbersShown()
  setLineNumbers(next)
  return next
}

/** The store surface for `useSyncExternalStore` (a primitive snapshot). */
export const lineNumbersStore = {
  subscribe(listener: () => void): () => void {
    const current = state()
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
    }
  },
  /** A boolean, so React never sees a fresh object on every read. */
  getSnapshot(): boolean {
    return state().shown
  },
}

/** Where a `:line` suffix sends the reader: a 1-based range, inclusive. */
export interface LineTarget {
  start: number
  /** Equal to `start` for a single line. */
  end: number
}

/**
 * Parse the part after the colon: `42`, `42-60`, `60-42` (the same range, in
 * the order a reader may write it). Anything else is not a line suffix —
 * `undefined`, so the caller keeps the whole text as a file name.
 *
 * Lines are 1-based: `0` is not a line, and a range that starts at `0` is not
 * one either.
 */
export function parseLineSpec(spec: string): LineTarget | undefined {
  const text = spec.trim()
  if (text === '') return undefined
  const single = /^(\d+)$/.exec(text)
  if (single !== null) {
    const line = Number.parseInt(single[1] as string, 10)
    return line >= 1 ? { start: line, end: line } : undefined
  }
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(text)
  if (range === null) return undefined
  const first = Number.parseInt(range[1] as string, 10)
  const second = Number.parseInt(range[2] as string, 10)
  if (first < 1 || second < 1) return undefined
  return { start: Math.min(first, second), end: Math.max(first, second) }
}

/**
 * Split `path:line` into its two halves.
 *
 * The **last** colon is the separator, and only when what follows it parses as
 * a line spec — a path may contain a colon of its own, and `src/app.ts:` is a
 * half-typed suffix, not a line. No valid suffix means `target: undefined` and
 * the whole (trimmed) text as the path, so quick open filters as it always has.
 */
export function splitLineSuffix(query: string): { path: string; target: LineTarget | undefined } {
  const text = query.trim()
  const colon = text.lastIndexOf(':')
  if (colon === -1) return { path: text, target: undefined }
  const target = parseLineSpec(text.slice(colon + 1))
  if (target === undefined) return { path: text, target: undefined }
  return { path: text.slice(0, colon).trim(), target }
}

/**
 * What a target asks of a file of `count` lines: both ends clamped into the
 * file (`:999` in a ten-line file lands on line 10 — the reader asked for "the
 * end", and a silent no-op would look like a broken key).
 */
export function clampTarget(target: LineTarget, count: number): LineTarget {
  const last = Math.max(1, count)
  return {
    start: Math.min(Math.max(1, target.start), last),
    end: Math.min(Math.max(1, target.end), last),
  }
}

/** `42` or `42-60`: what a surface prints back to the reader. */
export function formatLineSpec(target: LineTarget): string {
  return target.start === target.end ? String(target.start) : `${target.start}-${target.end}`
}
