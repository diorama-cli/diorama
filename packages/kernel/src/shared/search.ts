/**
 * File search, shared by the kernel's server and client halves (contract.md
 * §3.9). Pure functions and types only: no Node, no React, no Cordis — the
 * server walks the tree and the browser ranks what came back, and both must
 * agree on what "matches" means.
 *
 * Two questions, one file:
 *
 * - **by name** (`kind: 'name'`) — the file tree's own search (VS Code's
 *   `Ctrl+P`): a subsequence match on the path, so `appts` finds
 *   `src/app.ts`. Cheap enough to run over every path of a mount.
 * - **by content** (`kind: 'content'`) — literal text inside files, with the
 *   line and the column of every hit. Files are decoded as UTF-8 and binary
 *   ones are skipped (the same NUL-byte rule as `fs.readText`).
 */

import type { RelPath } from './types.ts'

/** What a search looks for (contract.md §3.9). */
export type SearchKind = 'name' | 'content'

/** One hit (contract.md §3.9). `line` / `column` are 1-based; `length` is in characters. */
export interface SearchMatch {
  path: RelPath
  /** 1-based line of the first hit on that line. */
  line?: number
  /** 1-based column (in characters) of the hit. */
  column?: number
  /** Characters matched on that line. */
  length?: number
  /** The line, trimmed for display (long lines are clipped). */
  text?: string
}

/** One file with hits, or (name search) a file whose path matched. */
export interface SearchFile {
  path: RelPath
  /** Hits in this file; a name hit has none. */
  matches: SearchMatch[]
  /** Total hits in this file — may exceed `matches.length` when clipped. */
  count: number
}

/** The result of one `search()` call (contract.md §3.9). */
export interface SearchResult {
  kind: SearchKind
  files: SearchFile[]
  /** Total files with hits, including ones past the limit. */
  totalFiles: number
  /** Total hits, including ones past the limit. */
  totalMatches: number
  /** `files` (or their matches) hit a limit: this is a prefix. */
  truncated: boolean
}

/** Options of one search (contract.md §3.9). */
export interface SearchOptions {
  kind?: SearchKind
  /** Case sensitivity; default `false` (case-insensitive). */
  caseSensitive?: boolean
  /** Whole word only (`\\b` around the query); default `false`. */
  wholeWord?: boolean
  /** Treat the query as a regular expression; default `false` (literal). */
  regex?: boolean
  /** Only paths under this directory ('' = the mount root). */
  scope?: RelPath
  /** Files returned at most; default `SEARCH_MAX_FILES`. */
  maxFiles?: number
  /** Hits per file at most; default `SEARCH_MAX_MATCHES_PER_FILE`. */
  maxMatchesPerFile?: number
}

/** Files one search returns at most (contract.md §3.9). */
export const SEARCH_MAX_FILES = 200

/** Hits kept per file (contract.md §3.9); `count` still reports the real total. */
export const SEARCH_MAX_MATCHES_PER_FILE = 20

/**
 * Files one search reads at most. A content search walks the whole tree, so the
 * cap bounds the work of a query over a huge directory (the result says
 * `truncated`).
 */
export const SEARCH_MAX_SCANNED_FILES = 20_000

/** Characters of one line kept for display (the hit is always inside the clip). */
export const SEARCH_LINE_MAX_CHARS = 240

/** Characters of a name-search query accepted (`EINVAL` past it). */
export const SEARCH_MAX_QUERY_CHARS = 200

/**
 * The character scores of a fuzzy match. Matched characters score by what they
 * follow, so `app` scores higher in `app.ts` than in `x/a/x/p/p.ts`.
 */
const SCORE_BASE = 1
const SCORE_CONSECUTIVE = 4
const SCORE_SEPARATOR = 6
const SCORE_CAMEL = 3
const PENALTY_GAP = 0.5

/** A subsequence match of `query` in `text`, with the positions it used. */
export interface FuzzyMatch {
  /** Character indexes matched, ascending. */
  positions: number[]
  score: number
}

/** Whether `text` contains the query's characters in order (a cheap pre-filter). */
export function isSubsequence(text: string, query: string): boolean {
  let index = 0
  for (const char of query) {
    index = text.indexOf(char, index)
    if (index === -1) return false
    index++
  }
  return true
}

/**
 * Score one subsequence match, preferring consecutive runs, matches right after
 * a separator (`/`, `.`, `-`, `_`) and camel-case boundaries — the usual
 * "quick open" ranking. Returns `undefined` when the text does not match.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | undefined {
  if (query === '') return { positions: [], score: 0 }
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const positions: number[] = []
  let score = 0
  let cursor = 0
  let previous = -2
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) return undefined
    positions.push(found)
    score += SCORE_BASE
    if (found === previous + 1) score += SCORE_CONSECUTIVE
    const before = found === 0 ? '' : (text[found - 1] ?? '')
    if (found === 0 || SEPARATORS.has(before)) score += SCORE_SEPARATOR
    else if (before !== before.toLowerCase() && (text[found] ?? '') === (text[found] ?? '').toLowerCase()) score += SCORE_CAMEL
    if (found > previous + 1) score -= (found - previous - 1) * PENALTY_GAP
    previous = found
    cursor = found + 1
  }
  // The basename matters more than the directories above it.
  const slash = text.lastIndexOf('/')
  if (positions.length > 0 && (positions[0] ?? 0) > slash) score += SCORE_SEPARATOR
  // A shorter path is the more likely target when the scores tie.
  return { positions, score: score - text.length * 0.01 }
}

const SEPARATORS = new Set(['/', '\\', '.', '-', '_', ' '])

/** Order for name results: score first, then the shorter path, then the name. */
export function compareNameMatches(
  a: { path: string; score: number },
  b: { path: string; score: number },
): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.path.length !== b.path.length) return a.path.length - b.path.length
  return a.path.localeCompare(b.path)
}

/**
 * Build the matcher of a content search. `regex` compiles the query (an
 * invalid expression is `undefined` — the caller reports `EINVAL`), `wholeWord`
 * wraps it in word boundaries, and the default is a literal substring.
 */
export function contentMatcher(options: {
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}): { test(line: string): { column: number; length: number }[] } | undefined {
  const flags = options.caseSensitive === true ? 'g' : 'gi'
  let source: string
  if (options.regex === true) {
    source = options.query
  } else {
    source = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  if (options.wholeWord === true) source = `\\b(?:${source})\\b`
  let pattern: RegExp
  try {
    pattern = new RegExp(source, flags)
  } catch {
    return undefined
  }
  return {
    test(line) {
      pattern.lastIndex = 0
      const hits: { column: number; length: number }[] = []
      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        hits.push({ column: match.index + 1, length: Math.max(match[0].length, 1) })
        // An empty match would loop forever (a regex like `x*`).
        if (match[0] === '') pattern.lastIndex++
      }
      return hits
    },
  }
}

/**
 * Clip one line for display around the first hit: the hit stays visible and
 * the rest is elided, so a minified file still shows a readable row.
 */
export function clipLine(line: string, column: number, length: number): string {
  // The line is kept verbatim (columns stay meaningful); only a long one is
  // clipped around the hit, with ellipses marking what was cut.
  const text = line.replace(/\r$/, '')
  if (text.length <= SEARCH_LINE_MAX_CHARS) return text
  const start = Math.max(0, Math.min(column - 1, text.length - SEARCH_LINE_MAX_CHARS + length))
  const end = Math.min(text.length, start + SEARCH_LINE_MAX_CHARS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Whether a file's bytes look binary (the NUL rule of `fs.readText`). */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000)
  for (let index = 0; index < limit; index++) if (bytes[index] === 0) return true
  return false
}
