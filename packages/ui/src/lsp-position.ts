/**
 * Pure position helpers of the navigation gestures (contract.md §3.12).
 *
 * Kept out of `lsp-gestures.tsx` for one reason: `node --test` cannot import a
 * `.tsx` (docs/m4/spec.md §12), and these rules are exactly the ones worth
 * pinning — a column that is off by one asks the server about the wrong symbol
 * and the jump lands somewhere plausible but wrong, which is worse than no
 * jump at all.
 */

/** A 1-based line and a 0-based UTF-16 column — the page's own units. */
export interface TextPosition {
  line: number
  character: number
}

/** Whether `ch` can be part of an identifier the page will ask about. */
export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
}

/**
 * The start of the identifier under a caret, so a click **inside** a word asks
 * about the word. A click on whitespace, punctuation or past the end of the
 * line has no identifier and answers `undefined` — the caller then sends the raw
 * position, and the server decides.
 *
 * The column is UTF-16 code units (what a DOM caret gives), and `text[character]`
 * indexes exactly that, so no conversion is needed here.
 */
export function wordAt(text: string, position: TextPosition): TextPosition | undefined {
  const source = text.split('\n')[position.line - 1]
  if (source === undefined) return undefined
  const start = position.character
  if (!isWordChar(source[start])) return undefined
  let first = start
  while (first > 0 && isWordChar(source[first - 1])) first--
  return { line: position.line, character: first }
}

/**
 * Where a renderer keeps "this row is line N of the file" and "the text of
 * that row starts here".
 *
 * `trim` is how many characters the cell adds in front of the file's own text
 * — the unified diff's `+` / `-` / space prefix. Without it every column would be
 * one to the right, and a definition would resolve to the neighbouring word.
 */
export interface RowGeometry {
  /** The attribute holding the 1-based line number in the **current** file. */
  lineAttribute: string
  /** Selector, inside the row, for the cell whose text is the file's columns. */
  cellSelector: string
  /** Characters in front of the file's text (a diff prefix); absent = 0. */
  trim?: number
}

/** The text renderers' geometry: one row per line, the text in its own cell. */
export const TEXT_ROWS: RowGeometry = { lineAttribute: 'data-line-number', cellSelector: '.diorama-line__text' }

/**
 * The identifier that starts at \`position\`, as text — what an underline is
 * drawn over.
 *
 * The column is UTF-16, so \`text[character]\` indexes the same unit a DOM caret
 * reports; a word may contain \`$\` and \`_\` but never whitespace or punctuation,
 * which is exactly what \`isWordChar\` says.
 */
export function wordTextAt(text: string, position: TextPosition): string {
  const source = text.split('\n')[position.line - 1]
  if (source === undefined) return ''
  if (!isWordChar(source[position.character])) return ''
  let end = position.character
  while (end < source.length && isWordChar(source[end])) end++
  return source.slice(position.character, end)
}
