/**
 * Colour the content readers (git-changes): rows → highlighted HTML.
 *
 * The two readers that show **file content** — the whole file with the change
 * laid into it, and the side-by-side pair — draw one row per element, so a row
 * cannot rely on markup that a neighbouring row opened. The engine therefore
 * answers **one HTML fragment per line** (`Highlighter.lines`, contract.md
 * §5.2), and this module is the mapping from a reader's rows to those lines:
 *
 * - a row that exists in the current file takes the line with its own number;
 * - a **deleted** row does not exist in the file at all (its text is the
 *   diff's copy), so a run of them is highlighted together and split again —
 *   a multi-line string or comment among them stays one construct, which
 *   highlighting each row alone would lose.
 *
 * Pure on purpose: no React, no engine import. The caller passes the engine
 * (the `code` piece publishes it on the page), so `node --test` can pin the
 * numbering rules with a fake one.
 */
import type { FileRow, SplitRow } from './model.ts'

/** What this module needs of an engine: one text → one HTML fragment per line. */
export interface LineHighlighter {
  lines(text: string, path: string): string[]
}

/** Highlighted HTML for every row of a whole-file body (`undefined` = draw plain). */
export function colorFileRows(
  rows: readonly FileRow[],
  fileHtml: readonly string[],
  highlight: LineHighlighter,
  path: string,
): (string | undefined)[] {
  const out: (string | undefined)[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index] as FileRow
    if (row.number !== undefined) {
      out.push(fileHtml[row.number - 1])
      index += 1
      continue
    }
    // A run of deleted rows: highlight the run as one text, then split it.
    const run: FileRow[] = []
    while (index < rows.length) {
      const next = rows[index] as FileRow
      if (next.number !== undefined) break
      run.push(next)
      index += 1
    }
    const html = highlight.lines(run.map(item => item.text).join('\n'), path)
    for (let offset = 0; offset < run.length; offset++) out.push(html[offset])
  }
  return out
}

/** One row of the side-by-side reader, coloured: the old side and the new one. */
export interface SplitCellHtml {
  /** The left (old file) cell's HTML; `undefined` = draw plain. */
  old: string | undefined
  /** The right (new file) cell's HTML; `undefined` = draw plain. */
  next: string | undefined
}

/** The fragment of one file line (1-based number); `undefined` outside the file. */
function lineHtml(fileHtml: readonly string[], number: number | undefined): string | undefined {
  return number === undefined ? undefined : fileHtml[number - 1]
}

/**
 * Highlighted HTML for every row of a side-by-side body.
 *
 * Both columns come from the **same** file read (contract.md §23): an
 * unchanged row is the same text on either side, so the right column's line
 * serves both. Only the deleted cells are missing from that file, and those
 * are highlighted in runs the way {@link colorFileRows} does it.
 */
export function colorSplitRows(
  rows: readonly SplitRow[],
  fileHtml: readonly string[],
  highlight: LineHighlighter,
  path: string,
): SplitCellHtml[] {
  const out: SplitCellHtml[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index] as SplitRow
    if (row.old?.tone !== 'del') {
      // Unchanged or added: the text is in the current file, at the new number,
      // and an unchanged row is the *same* line on both sides.
      const html = row.next === undefined ? undefined : lineHtml(fileHtml, row.next.number)
      // A pure insertion has no left cell at all: nothing to colour there.
      out.push({ old: row.old === undefined ? undefined : html, next: html })
      index += 1
      continue
    }
    // A run of deletions: the left column is not in the file at all (the diff's
    // copy is the only one), so the run is highlighted as one text — a
    // multi-line string or comment among them stays one construct.
    const run: SplitRow[] = []
    while (index < rows.length) {
      const next = rows[index] as SplitRow
      if (next.old?.tone !== 'del') break
      run.push(next)
      index += 1
    }
    const deleted = highlight.lines(run.map(item => item.old?.text ?? '').join('\n'), path)
    run.forEach((item, offset) => {
      // The row may still carry an insertion on the right (git pairs a
      // replacement's deletions with its insertions, contract.md §23): that
      // cell is a line of the current file, so it has its own fragment.
      const next = item.next === undefined ? undefined : lineHtml(fileHtml, item.next.number)
      out.push({ old: deleted[offset], next })
    })
  }
  return out
}
