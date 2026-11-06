/**
 * LSP vocabulary shared by both halves of `ctx.lsp` (contract.md §3.12).
 *
 * The shapes here are **already translated**: the protocol's 0-based
 * `line`/`character` are the only place they appear. Everything that leaves
 * the server — and everything a renderer hands in — speaks 1-based lines and
 * UTF-16 columns, the same units the line model and the DOM selection use
 * (`docs/m27/spec.md`, contract.md §3.11). The conversion is a pure function
 * (`toLsp` / `fromLsp`) so it can be pinned by `node --test`.
 *
 * Why 1-based lines: `reveal()` takes a 1-based line, a gutter draws 1-based
 * numbers, and `path:42` in the palette is 1-based. A 0-based number leaking
 * into any of those is an off-by-one nobody notices until the wrong line is
 * highlighted — so the boundary is one file and it is tested.
 */
import type { RelPath } from './types.ts'

/** A 1-based line and a **UTF-16** column, as the page counts them. */
export interface LspPosition {
  /** 1-based line. */
  line: number
  /**
   * 0-based column in **UTF-16 code units** — the DOM's `Selection` unit and
   * therefore the one a click gives us for free.
   */
  character: number
}

/** A range of the file, both ends 1-based (see {@link LspPosition}). */
export interface LspRange {
  start: LspPosition
  end: LspPosition
}

/** Somewhere in the mount: a file and a range inside it. */
export interface LspLocation {
  /** Mount-relative path (`/`-separated, no leading `/`). */
  path: RelPath
  range: LspRange
}

/** What a hover shows (contract.md §3.12). */
export interface LspHover {
  /** Markdown the server produced; the renderer decides whether to trust it. */
  contents: string
  /** The range the server answered for; absent when it answered for the position. */
  range?: LspRange
}

/** One entry of a file's outline. */
export interface LspSymbol {
  name: string
  /** LSP `SymbolKind` (1–26); the page maps it to an icon. */
  kind: number
  /** The whole declaration. */
  range: LspRange
  /** Just the name — what a click should select. */
  selectionRange: LspRange
  children?: LspSymbol[]
}

/** Which language server a mount has, and whether it is usable (contract.md §3.12). */
export interface LspServerInfo {
  /** The language id this server claims, e.g. `typescript`, `c`, `go`. */
  language: string
  /** The executable that was launched. */
  command: string
  /** `running`: the process answered `initialize`. */
  state: 'running' | 'installing' | 'unavailable'
  /** Why it is unavailable, when it is. */
  reason?: string
}

/** LSP `SymbolKind` values the page draws differently (contract.md §3.12). */
export const SYMBOL_KIND_NAMES: Readonly<Record<number, string>> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enumMember',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'typeParameter',
}

/**
 * The protocol's own position (0-based line, 0-based UTF-16 character) from
 * ours. Kept total: a page can hand in anything, and a bad number must not
 * reach the server as `NaN`.
 */
export function toLsp(position: LspPosition): { line: number; character: number } {
  return {
    line: positive(Math.trunc(position.line) - 1),
    character: positive(Math.trunc(position.character)),
  }
}

/** A non-negative integer, or `0` — `NaN` must never reach the wire. */
function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Ours from the protocol's. See {@link toLsp}. */
export function fromLsp(position: { line: number; character: number }): LspPosition {
  return {
    line: positive(Math.trunc(position.line)) + 1,
    character: positive(Math.trunc(position.character)),
  }
}

/** A range in our units, from the protocol's. */
export function fromLspRange(range: {
  start: { line: number; character: number }
  end: { line: number; character: number }
}): LspRange {
  return { start: fromLsp(range.start), end: fromLsp(range.end) }
}

/**
 * Which language a path is, or `undefined` when no server in this build claims
 * it. One table, because the server half (which launches a process) and the
 * page (which decides whether to underline a word) must agree — a mismatch is
 * a request that can never be answered.
 */
export const LSP_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  typescript: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'],
  go: ['go'],
}

/** The language id a path belongs to (by extension), or `undefined`. */
export function languageOfPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return undefined
  const ext = path.slice(dot + 1).toLowerCase()
  for (const [language, extensions] of Object.entries(LSP_LANGUAGES)) {
    if (extensions.includes(ext)) return language
  }
  return undefined
}
