/**
 * Pure helpers of the `search` piece: turn a `SearchResult` into the flat rows
 * a list draws, and split text into highlighted / plain segments.
 *
 * No React and no kernel here, so `node --test` can import this file directly
 * (the same split as `help/bindings.ts`).
 */
import type { SearchFile, SearchMatch, SearchResult } from 'diorama-kernel'

/** One row of the results list: a file header, or one hit inside a file. */
export interface ResultRow {
  kind: 'file' | 'match'
  /** The file the row belongs to. */
  path: string
  /** The hit (a `match` row only). */
  match?: SearchMatch
  /** The file's entry (a `file` row only). */
  file?: SearchFile
  /** The file's hit count (a `file` row only). */
  count: number
}

/**
 * Flatten a result into rows. A collapsed file contributes its header only; an
 * expanded one contributes its kept matches right below it. Name results have
 * no matches at all, so every row is a file.
 */
export function flattenResult(result: SearchResult | undefined, collapsed: ReadonlySet<string>): ResultRow[] {
  if (result === undefined) return []
  const rows: ResultRow[] = []
  for (const file of result.files) {
    rows.push({ kind: 'file', path: file.path, file, count: file.count })
    if (collapsed.has(file.path)) continue
    for (const match of file.matches) rows.push({ kind: 'match', path: file.path, match, count: file.count })
  }
  return rows
}

/** The path's directory (with a trailing `/`) and its file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? { dir: '', name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

/** One run of text: matched (highlighted) or plain. */
export interface Segment {
  text: string
  match: boolean
}

/**
 * Split `text` around `[column, column + length)` (1-based, in `text`). A hit
 * outside the text is returned whole and unhighlighted rather than clipped
 * wrongly.
 */
export function highlightRange(text: string, column: number | undefined, length: number | undefined): Segment[] {
  if (column === undefined || length === undefined || length <= 0) return [{ text, match: false }]
  const start = column - 1
  const end = start + length
  if (start < 0 || start >= text.length) return [{ text, match: false }]
  const segments: Segment[] = []
  if (start > 0) segments.push({ text: text.slice(0, start), match: false })
  segments.push({ text: text.slice(start, Math.min(end, text.length)), match: true })
  if (end < text.length) segments.push({ text: text.slice(end), match: false })
  return segments
}

/** Split a path around the characters a fuzzy match used (the quick-open list). */
export function highlightPositions(text: string, positions: readonly number[]): Segment[] {
  if (positions.length === 0) return [{ text, match: false }]
  const marked = new Set(positions)
  const segments: Segment[] = []
  for (let index = 0; index < text.length; index++) {
    const match = marked.has(index)
    const last = segments[segments.length - 1]
    if (last !== undefined && last.match === match) last.text += text[index] ?? ''
    else segments.push({ text: text[index] ?? '', match })
  }
  return segments
}

/** The summary line under the search field (VS Code's "N results in M files"). */
export function summarize(result: SearchResult | undefined): string {
  if (result === undefined) return ''
  if (result.totalFiles === 0) return '没有匹配'
  if (result.kind === 'name') {
    return `${result.totalFiles} 个文件${result.truncated ? '（已截断）' : ''}`
  }
  const files = `${result.totalFiles} 个文件`
  const matches = `${result.totalMatches} 处匹配`
  return `${files}，${matches}${result.truncated ? '（已截断）' : ''}`
}
