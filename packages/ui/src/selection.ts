/**
 * Selecting text in a **row-per-line** reader (contract.md §3.11).
 *
 * Once the text renderers draw one element per line, the browser's own
 * selection highlight stops looking like one selection: it paints the **inline
 * boxes** it finds, so every row gets its own rectangle of its own length, the
 * gutter is skipped (`user-select: none`) and the rows that are separated by a
 * block boundary show a seam. That is not a styling detail — a copied block of
 * forty lines read as forty unrelated strips.
 *
 * An editor solves this the same way: it stops relying on the native highlight
 * and paints the selection itself. This module does that, and keeps the native
 * one as the source of truth:
 *
 * - the **native highlight is made transparent** for the readers only
 *   (`.diorama-code`, `.diorama-plaintext`), so text stays selectable, copyable
 *   and searchable exactly as before;
 * - a `selectionchange` listener turns the DOM range into **row boxes**:
 *   every box starts at the row's **first selected character** and a row
 *   covered to its end runs from there to the right edge. **The gutter is
 *   never painted** — the line numbers are not part of what was selected, and
 *   a box that covered them would say otherwise. What joins consecutive rows
 *   into one block is the gutter being *constant*: the rows below the first
 *   start at the same x and run to the same right edge, so there is no step
 *   between them.
 *
 * The boxes are drawn by CSS on the rows themselves (`data-sel` plus a custom
 * property for the column the text starts at), so nothing is re-rendered and
 * scrolling costs nothing.
 *
 * No React: the rows are plain elements, and `node --test` can pin the
 * arithmetic (`selectionBoxes`) without a DOM.
 */

/** One row's slice of the selection, in characters of that row's text. */
export interface SelectionSlice {
  /** 1-based line number (the row's `data-line-number`). */
  line: number
  /** First selected character of the row (0-based, inclusive). */
  start: number
  /** Last selected character of the row (0-based, inclusive). */
  end: number
  /** Every character of the row is selected (draw the full width). */
  full: boolean
}

/**
 * Turn a list of (line, start, end) runs into **one slice per line**, merging
 * runs that meet on the same line.
 *
 * A selection is a contiguous range, so in practice there is one run per line —
 * but a caller may hand several (a future multi-cursor, a search highlight), and
 * two runs on one line must read as one slice rather than two boxes that meet.
 * Input is not assumed to be sorted.
 *
 * `full` means "this row is selected from its first character to its last", and
 * is the only case drawn to the row's edges. A run that starts in the middle of
 * a row stays a run: a selection whose first line was dragged from the middle
 * of that line must show where it begins, not the whole line.
 */
export function selectionSlices(runs: readonly Omit<SelectionSlice, 'full'>[], lineLengths: ReadonlyMap<number, number>): SelectionSlice[] {
  const byLine = new Map<number, { start: number; end: number }>()
  for (const run of runs) {
    if (run.line < 1) continue
    const start = Math.max(0, Math.min(run.start, run.end))
    const end = Math.max(run.start, run.end)
    const current = byLine.get(run.line)
    if (current === undefined) byLine.set(run.line, { start, end })
    else byLine.set(run.line, { start: Math.min(current.start, start), end: Math.max(current.end, end) })
  }
  const slices: SelectionSlice[] = []
  for (const [line, run] of [...byLine].sort((a, b) => a[0] - b[0])) {
    const length = lineLengths.get(line) ?? 0
    // A block is a row selected **from its first character to its last**: only
    // then may it be drawn to the row's edges (an editor shows a whole line that
    // way, and that is what joins consecutive rows into one block). A run that
    // starts in the middle of the row is not a block, however far it reaches —
    // the first row of a selection is exactly that case.
    const full = length > 0 && run.start === 0 && run.end >= length - 1
    slices.push({ line, start: run.start, end: run.end, full })
  }
  return slices
}

/** The text element of a row (the part the offsets are counted in). */
function textOf(row: Element): HTMLElement | null {
  return row.querySelector<HTMLElement>('.diorama-line__text')
}

/**
 * Where in a row's text a selection boundary sits, **in characters**.
 *
 * The text element holds the row's markup (a highlighted line is many spans),
 * so the offset is the length of everything before the boundary — the same
 * unit as {@link SelectionSlice}, and the unit `Range` itself works in.
 */
function offsetIn(row: Element, node: Node, offset: number): number {
  const text = textOf(row)
  if (text === null) return 0
  const range = document.createRange()
  range.selectNodeContents(text)
  try {
    range.setEnd(node, offset)
  } catch {
    // The boundary is not inside this row (it sits on the row itself).
    return 0
  }
  return range.toString().length
}

/** The text node + offset a character index lands on (for a pixel-accurate Range). */
function pointAt(text: HTMLElement, index: number): { node: Node; offset: number } | undefined {
  let remaining = index
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) return { node, offset: remaining }
    remaining -= length
  }
  // Past the end (an empty row, or a boundary the row's text does not reach).
  return undefined
}

/** Where the row's text starts, relative to the row (the gutter's width). */
function textLeft(row: Element): number {
  const text = textOf(row)
  if (text === null) return 0
  return text.getBoundingClientRect().left - row.getBoundingClientRect().left
}

/** The pixel box of the characters `[start, end)` of a row's text, relative to the text element. */
function runBox(row: Element, start: number, end: number): { left: number; width: number } | undefined {
  const text = textOf(row)
  if (text === null) return undefined
  const from = pointAt(text, start)
  const to = pointAt(text, end)
  if (from === undefined || to === undefined) return undefined
  const range = document.createRange()
  try {
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
  } catch {
    return undefined
  }
  const box = range.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return undefined
  const base = text.getBoundingClientRect()
  return { left: box.left - base.left, width: box.width }
}

/** The row element an anchor/focus node belongs to, if it is one of ours. */
function rowOf(node: Node | null): HTMLElement | null {
  if (node === null) return null
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return element?.closest<HTMLElement>('.diorama-line[data-line-number]') ?? null
}

/** The line number a row carries. */
function lineOf(row: HTMLElement): number {
  return Number.parseInt(row.dataset.lineNumber ?? '', 10)
}

/** The text length of a row (what `selectionSlices` needs to know "the end"). */
function lengthOf(row: HTMLElement): number {
  return row.querySelector('.diorama-line__text')?.textContent?.length ?? 0
}

/**
 * The slices a DOM `Selection` covers, in the rows of `container`.
 *
 * `undefined` when the selection is empty or lies outside the container — the
 * caller then clears every box.
 */
export function slicesOfSelection(selection: Selection | null, container: HTMLElement): SelectionSlice[] | undefined {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return undefined
  const range = selection.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return undefined
  const first = rowOf(range.startContainer)
  const last = rowOf(range.endContainer)
  if (first === null || last === null) return undefined
  const firstLine = lineOf(first)
  const lastLine = lineOf(last)
  const runs: Omit<SelectionSlice, 'full'>[] = []
  const lengths = new Map<number, number>()
  for (const row of container.querySelectorAll<HTMLElement>('.diorama-line[data-line-number]')) {
    const line = lineOf(row)
    if (!Number.isFinite(line) || line < firstLine || line > lastLine) continue
    const length = lengthOf(row)
    lengths.set(line, length)
    const start = line === firstLine ? offsetIn(row, range.startContainer, range.startOffset) : 0
    const end = line === lastLine ? offsetIn(row, range.endContainer, range.endOffset) : length - 1
    runs.push({ line, start, end: Math.max(start, end) })
  }
  return selectionSlices(runs, lengths)
}

/**
 * Follow the page's selection inside `container` and write one custom property
 * per row:
 *
 * - `data-sel="full"` on a row the selection covers to the end;
 * - `data-sel="part"` on a row it covers in part;
 * - `--dio-sel-left` / `--dio-sel-width` on **both**: the measured box, from the
 *   row's first selected character (so a selection that starts mid-row shows
 *   that, rather than snapping to the text's edge);
 * - `--dio-line-gutter` on both: the column the row's text starts at, which is
 *   where the box starts when the row is selected from its beginning (the line
 *   number is never inside the selection).
 *
 * Returns the unsubscriber (call it from the renderer's effect cleanup).
 */
export function watchSelection(container: HTMLElement): () => void {
  const clear = (row: HTMLElement): void => {
    row.removeAttribute('data-sel')
    row.style.removeProperty('--dio-sel-left')
    row.style.removeProperty('--dio-sel-width')
    row.style.removeProperty('--dio-line-gutter')
  }
  const update = (): void => {
    const slices = slicesOfSelection(window.getSelection(), container)
    if (slices === undefined || slices.length === 0) {
      for (const row of container.querySelectorAll<HTMLElement>('.diorama-line[data-line-number]')) clear(row)
      return
    }
    const byLine = new Map(slices.map(slice => [slice.line, slice]))
    for (const row of container.querySelectorAll<HTMLElement>('.diorama-line[data-line-number]')) {
      const slice = byLine.get(lineOf(row))
      if (slice === undefined) {
        clear(row)
        continue
      }
      // Every box starts where the row's text starts: the gutter is not part of
      // the selection, so it is never painted (the number would read as
      // selected). What joins consecutive rows into one block is that this
      // column is the same on every row — the blocks line up edge to edge.
      const gutter = textLeft(row)
      row.style.setProperty('--dio-line-gutter', `${gutter}px`)
      const box = runBox(row, slice.start, slice.end + 1)
      if (box === undefined) {
        // Nothing of the row's text is selected (the range ends on the newline
        // of the row above, or the row is empty): there is no run to draw.
        clear(row)
        continue
      }
      // Measured for both kinds: "full" is the same box taken to the right edge
      // of the row (rows of different lengths then read as one block), a partial
      // run stops at the last selected character. Never at the text's start —
      // a selection that begins in the middle of a row must show that.
      row.setAttribute('data-sel', slice.full ? 'full' : 'part')
      row.style.setProperty('--dio-sel-left', `${box.left}px`)
      row.style.setProperty('--dio-sel-width', `${box.width}px`)
    }
  }
  // `selectionchange` fires on the document, not the element; listening there
  // is also what catches a selection started outside and dragged inside.
  document.addEventListener('selectionchange', update)
  update()
  return () => {
    document.removeEventListener('selectionchange', update)
    for (const row of container.querySelectorAll<HTMLElement>('.diorama-line[data-line-number]')) clear(row)
  }
}
