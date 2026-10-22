/**
 * The diff model (git-changes): unified diff text → what a reader needs.
 *
 * The kernel hands over **text** (contract.md §3.2: `ctx.git` does not parse a
 * diff for anyone), and every surface of this piece needs the same three things
 * out of it:
 *
 * - **lines with a tone and the two line numbers** — the inline reader draws a
 *   gutter, the whole-file reader draws the file's own numbering;
 * - **hunks** — "next change / previous change" has to have somewhere to go,
 *   and the count of them is the reader's map of the file;
 * - **the file with its changes laid into it** — a reader who cannot see the
 *   code around a change is reading a sentence without its paragraph
 *   (`git show <rev>:<path>` is one `ctx.git.blob` away, and that is what
 *   {@link buildFileRows} folds the diff into).
 *
 * Pure on purpose: no React, no IO, so `node --test` can pin the rules
 * (docs/m4/spec.md §6.2: a `.tsx` cannot be imported by `node --test`).
 */

/** How a row of a diff (or of the file it changes) is coloured. */
export type DiffTone = 'add' | 'del' | 'context' | 'hunk' | 'meta'

/** One line of a unified diff, as the reader sees it. */
export interface DiffLine {
  /** Tone of the row (`@@` = `hunk`, `+++` / `---` / `diff …` = `meta`). */
  tone: DiffTone
  /** The line verbatim, **with** its `+` / `-` / space prefix. */
  text: string
  /** 1-based line number in the old file (absent on an added line). */
  oldLine?: number
  /** 1-based line number in the new file (absent on a deleted line). */
  newLine?: number
  /** 1-based hunk this row belongs to; `0` before the first `@@` (file headers). */
  hunk: number
}

/** One `@@ -a,b +c,d @@` block: the unit "next change" moves between. */
export interface DiffHunk {
  /** 1-based hunk number, in file order. */
  index: number
  /** The `@@ … @@` line verbatim. */
  header: string
  /** What git put after the closing `@@` (usually the enclosing function). */
  section: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Row index of the header in the parsed line list (for scrolling). */
  row: number
}

/** Header prefixes git prints around the actual change (not content). */
const META_PREFIXES = [
  'diff ',
  'index ',
  'new file ',
  'deleted file ',
  'old mode ',
  'new mode ',
  'similarity ',
  'dissimilarity ',
  'rename ',
  'copy ',
  '\\ ',
]

/** The `@@ -a,b +c,d @@ section` line, with git's shorthand for a 1-line range. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** Split a text into lines, dropping the trailing newline's empty tail. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The tone of one raw diff line. */
export function diffTone(line: string): DiffTone {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (META_PREFIXES.some(prefix => line.startsWith(prefix))) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

/** The parts of a hunk header, or `undefined` when the line is not one. */
export function parseHunkHeader(line: string): Omit<DiffHunk, 'index' | 'row' | 'header'> | undefined {
  const match = HUNK_HEADER.exec(line)
  if (match === null) return undefined
  const [, oldStart = '0', oldCount = '1', newStart = '0', newCount = '1', section = ''] = match
  return {
    section: section.trim(),
    oldStart: Number(oldStart),
    // `-1` means one line; `-0,0` means none (a pure insertion).
    oldCount: Number(oldCount),
    newStart: Number(newStart),
    newCount: Number(newCount),
  }
}

/**
 * Parse a unified diff into rows with tones and both line numbers.
 *
 * The line counters come from the `@@` header and advance per row, which is
 * what a gutter needs; a malformed header (`git diff` never writes one, but a
 * test fixture might) leaves the counters where they were rather than throwing
 * — a reader that shows the text is more useful than one that blanks.
 */
export function parseDiff(text: string): DiffLine[] {
  const rows: DiffLine[] = []
  let hunk = 0
  let oldLine = 0
  let newLine = 0
  for (const line of splitLines(text)) {
    const tone = diffTone(line)
    if (tone === 'hunk') {
      hunk += 1
      const header = parseHunkHeader(line)
      if (header !== undefined) {
        oldLine = header.oldStart
        newLine = header.newStart
      }
      rows.push({ tone, text: line, hunk })
      continue
    }
    if (tone === 'add') {
      rows.push({ tone, text: line, newLine, hunk })
      newLine += 1
      continue
    }
    if (tone === 'del') {
      rows.push({ tone, text: line, oldLine, hunk })
      oldLine += 1
      continue
    }
    if (tone === 'meta') {
      rows.push({ tone, text: line, hunk })
      continue
    }
    rows.push({ tone, text: line, oldLine, newLine, hunk })
    oldLine += 1
    newLine += 1
  }
  return rows
}

/** The hunks of a parsed diff, in file order. */
export function diffHunks(rows: readonly DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = []
  rows.forEach((row, index) => {
    if (row.tone !== 'hunk') return
    const header = parseHunkHeader(row.text)
    hunks.push({
      index: hunks.length + 1,
      header: row.text,
      section: header?.section ?? '',
      oldStart: header?.oldStart ?? 0,
      oldCount: header?.oldCount ?? 0,
      newStart: header?.newStart ?? 0,
      newCount: header?.newCount ?? 0,
      row: index,
    })
  })
  return hunks
}

/** How much a diff adds and removes (the header's `+12 −3`). */
export function diffStat(rows: readonly DiffLine[]): { added: number; removed: number; hunks: number } {
  let added = 0
  let removed = 0
  let hunks = 0
  for (const row of rows) {
    if (row.tone === 'add') added += 1
    else if (row.tone === 'del') removed += 1
    else if (row.tone === 'hunk') hunks += 1
  }
  return { added, removed, hunks }
}

/** One row of the whole-file view: the file's text, changes laid into it. */
export interface FileRow {
  /** Tone: unchanged, added, or the deleted line that used to be here. */
  tone: 'context' | 'add' | 'del'
  /** The line's text, **without** a diff prefix. */
  text: string
  /** 1-based number in the file as it is now (absent on a deleted row). */
  number?: number
  /** 1-based number in the old file (deleted rows only). */
  oldNumber?: number
}

/** A run of unchanged lines that was folded away (`collapseFileRows`). */
export interface FileGap {
  /** Rows the run would take if it were open. */
  count: number
  /** 1-based line numbers it spans (both ends included). */
  from: number
  to: number
  /** The change the run sits in front of: opening that change opens this run. */
  openedBy?: number
}

/** One change ("hunk") in the whole-file view: where it is and how to name it. */
export interface FileHunk {
  /** 1-based hunk number, in file order. */
  index: number
  /** Row index of the hunk's first changed row (not of the `@@` line). */
  row: number
  /** 1-based line in the current file the change starts at. */
  line: number
  /** What git put after `@@ … @@` (the enclosing function), when it said anything. */
  section: string
  added: number
  removed: number
}

/** What the whole-file view draws: rows, some runs folded, the changes numbered. */
export interface FileBody {
  rows: FileRow[]
  /** `rows[index]` is a folded run (draw it as a "n 行未改动" band). */
  gaps: Map<number, FileGap>
  /** The changes, in file order. */
  hunks: FileHunk[]
  /** Row counts per hunk, so opening one knows how far to expand. */
  spans: Map<number, number>
}

/** Runs this short are kept open (a band would cost more than the lines). */
const MIN_FOLD = 2

/**
 * Fold long runs of unchanged lines, keeping `context` lines around each
 * change and around the head of the file (a reader still wants to see what
 * file this is).
 *
 * This is what makes "show the whole file" usable: a 3000-line file with two
 * changed lines is one screen of reading, not 3000 rows. The rows are all
 * built anyway (the file is already here), so opening a run is pure state.
 *
 * `open` is the hunk the reader asked to see whole: the band that a change
 * sits next to opens up, which is what "go to the change and show it with its
 * context" means when the file is folded.
 */
export function collapseFileRows(rows: readonly FileRow[], context = 3, head = 2, open?: number): FileBody {
  const keep = new Set<number>()
  // The head of the file.
  for (let index = 0; index < Math.min(head, rows.length); index++) keep.add(index)
  // Which change each row belongs to (a change is a run of added / deleted rows).
  const changeOf: (number | undefined)[] = []
  let change = 0
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    if (row.tone !== 'context' && (previous === undefined || previous.tone === 'context')) change += 1
    changeOf[index] = row.tone === 'context' ? undefined : change
  })
  rows.forEach((row, index) => {
    if (row.tone === 'context') return
    for (let offset = -context; offset <= context; offset++) {
      const near = index + offset
      if (near >= 0 && near < rows.length) keep.add(near)
    }
  })
  if (open !== undefined) {
    // The run before the opened change and the run after it: both are "its
    // context", and both are already in `rows`.
    rows.forEach((_row, index) => {
      if (changeOf[index] !== open) return
      for (let cursor = index - 1; cursor >= 0 && rows[cursor]?.tone === 'context'; cursor--) keep.add(cursor)
      for (let cursor = index; cursor < rows.length && rows[cursor]?.tone === 'context'; cursor++) keep.add(cursor)
    })
  }
  // The change each position is followed by (its band belongs to that change).
  const nextChange: (number | undefined)[] = []
  for (let index = rows.length - 1; index >= 0; index--) {
    nextChange[index] = changeOf[index] ?? nextChange[index + 1]
  }
  const out: FileRow[] = []
  const gaps = new Map<number, FileGap>()
  const hunks: FileHunk[] = []
  const spans = new Map<number, number>()
  /** The run of unkept rows being collected, if any. */
  let run: FileRow[] | undefined
  /**
   * End the collected run. `next` is the change the run sits in front of: a
   * band belongs to the change that follows it, which is the one "open" means.
   */
  const flush = (next?: number): void => {
    if (run === undefined) return
    const first = run[0]
    const last = run[run.length - 1]
    // A run of one or two lines is not worth a band that has to be clicked:
    // folding it would cost the reader a click to see two lines of code.
    if (run.length <= MIN_FOLD) out.push(...run)
    else if (first !== undefined && last !== undefined) {
      gaps.set(out.length, { count: run.length, from: first.number ?? 0, to: last.number ?? 0, openedBy: next })
    }
    run = undefined
  }
  rows.forEach((row, index) => {
    if (!keep.has(index)) {
      run ??= []
      run.push(row)
      return
    }
    flush(nextChange[index])
    // A change is a run of added / deleted rows; the first of them opens the
    // hunk the reader can jump to (deleted rows carry the old numbering, so
    // the hunk is anchored on the first row that has a current line).
    const previous = rows[index - 1]
    const starts = row.tone !== 'context' && (previous === undefined || previous.tone === 'context')
    if (starts) {
      hunks.push({
        index: hunks.length + 1,
        row: out.length,
        line: firstLineOf(rows, index),
        section: '',
        added: 0,
        removed: 0,
      })
    }
    const current = hunks[hunks.length - 1]
    if (current !== undefined) {
      if (row.tone === 'add') current.added += 1
      if (row.tone === 'del') current.removed += 1
      spans.set(current.index, (spans.get(current.index) ?? 0) + 1)
    }
    out.push(row)
  })
  flush()
  return { rows: out, gaps, hunks, spans }
}

/**
 * The line a change starts at: its first row that has a number in the current
 * file (a pure deletion has only the old one, and that is the line it was at).
 */
function firstLineOf(rows: readonly FileRow[], index: number): number {
  for (let cursor = index; cursor < rows.length; cursor++) {
    const row = rows[cursor]
    if (row === undefined) break
    if (cursor > index && row.tone === 'context') break
    const line = row.number ?? row.oldNumber
    if (line !== undefined) return line
  }
  return 0
}

/**
 * Put the diff's `@@` context onto the changes of a collapsed file: git
 * already said which function each change sits in, and the header is the only
 * place that knowledge exists.
 */
export function labelHunks(body: FileBody, diffText: string): FileBody {
  const headers = diffHunks(parseDiff(diffText))
  return {
    ...body,
    hunks: body.hunks.map((hunk, index) => ({ ...hunk, section: headers[index]?.section ?? '' })),
  }
}

/** One side of a side-by-side row: the old file's line or the new file's. */
export interface SplitCell {
  /** 1-based line number in that file (absent = the side has no line here). */
  number?: number
  /** The line's text, **without** a diff prefix. */
  text: string
  /** `context` on both sides, `del` on the old side, `add` on the new one. */
  tone: 'context' | 'add' | 'del'
}

/** One row of the side-by-side reader: the two files' lines, aligned. */
export interface SplitRow {
  /** The old file's line (absent when this row only exists on the new side). */
  old?: SplitCell
  /** The new file's line (absent when this row only exists on the old side). */
  next?: SplitCell
  /** 1-based change this row belongs to (`0` = unchanged). */
  change: number
}

/** What the side-by-side reader draws: aligned rows, folded runs, the changes. */
export interface SplitBody {
  rows: SplitRow[]
  /** `rows[index]` is a folded run: both sides jump over the same lines. */
  gaps: Map<number, FileGap>
  /** The changes, in file order (the arrows walk these). */
  hunks: FileHunk[]
}

/**
 * Align the diff's two sides for the side-by-side reader.
 *
 * A hunk is a run of unchanged lines with deletions and insertions in it; git
 * prints all deletions before the insertions that replaced them, so pairing
 * them by position (the `diff` view of a merge) is what a reader expects:
 * `-` and `+` sit on the same row while they last, and whichever side runs
 * out first leaves a blank cell on the other. Unchanged lines pair with
 * themselves.
 *
 * **One file, two columns.** Only the file as it is now is read
 * (`ctx.fs.readText`, or `blob()` for a commit): an unchanged line is the
 * same text on both sides by definition, so the left column takes it from the
 * same list and only its **number** differs. A deleted line is not in that
 * file at all, so the diff's own copy is the only one there is. That is also
 * why this needs no second read of a file the working tree may no longer have.
 */
export function buildSplitRows(fileText: string, diffText: string): SplitRow[] {
  const fileLines = splitLines(fileText)
  const parsed = parseDiff(diffText)
  const hunks = diffHunks(parsed)
  const rows: SplitRow[] = []
  /** Where the walk has reached in each file (1-based). */
  let oldLine = 1
  let newLine = 1
  const pushRange = (oldTo: number, newTo: number): void => {
    while (oldLine < oldTo && newLine < newTo) {
      const text = fileLines[newLine - 1] ?? ''
      rows.push({
        old: { number: oldLine, text, tone: 'context' },
        next: { number: newLine, text, tone: 'context' },
        change: 0,
      })
      oldLine += 1
      newLine += 1
    }
  }
  for (const hunk of hunks) {
    pushRange(hunk.oldStart, hunk.newStart)
    // The hunk's own rows, with the deletions and insertions of one change
    // collected so they can be paired up.
    let deleted: SplitCell[] = []
    let inserted: SplitCell[] = []
    const flushChange = (): void => {
      const count = Math.max(deleted.length, inserted.length)
      if (count === 0) return
      const change = (rows[rows.length - 1]?.change ?? 0) + 1
      for (let index = 0; index < count; index++) {
        const left = deleted[index]
        const right = inserted[index]
        rows.push({
          ...(left === undefined ? {} : { old: left }),
          ...(right === undefined ? {} : { next: right }),
          change,
        })
      }
      deleted = []
      inserted = []
    }
    let hunkOld = hunk.oldStart
    let hunkNew = hunk.newStart
    for (let index = hunk.row + 1; index < parsed.length; index++) {
      const row = parsed[index] as DiffLine
      if (row.tone === 'hunk') break
      if (row.tone === 'context') {
        flushChange()
        // Unchanged: the same text on both sides, taken from the file itself
        // (the diff's copy is only the context git chose to print).
        const text = fileLines[hunkNew - 1] ?? row.text.slice(1)
        rows.push({
          old: { number: hunkOld, text, tone: 'context' },
          next: { number: hunkNew, text, tone: 'context' },
          change: 0,
        })
        hunkOld += 1
        hunkNew += 1
      } else if (row.tone === 'del') {
        deleted.push({ number: hunkOld, text: row.text.slice(1), tone: 'del' })
        hunkOld += 1
      } else if (row.tone === 'add') {
        inserted.push({ number: hunkNew, text: row.text.slice(1), tone: 'add' })
        hunkNew += 1
      }
    }
    flushChange()
    oldLine = Math.max(oldLine, hunkOld)
    newLine = Math.max(newLine, hunkNew)
  }
  pushRange(fileLines.length + 1, fileLines.length + 1)
  return rows
}

/**
 * Fold a side-by-side body the same way the whole-file reader does: both sides
 * jump over the same run, so one band hides a rectangle of two columns.
 *
 * `hunkCount` is the number of changes in the diff (from {@link diffHunks});
 * it is what "open change n" is numbered by, and it must agree with the
 * numbering the arrows use.
 */
export function collapseSplitRows(rows: readonly SplitRow[], context = 3, head = 2, open?: number): SplitBody {
  const keep = new Set<number>()
  for (let index = 0; index < Math.min(head, rows.length); index++) keep.add(index)
  rows.forEach((row, index) => {
    if (row.change === 0) return
    for (let offset = -context; offset <= context; offset++) {
      const near = index + offset
      if (near >= 0 && near < rows.length) keep.add(near)
    }
  })
  if (open !== undefined) {
    rows.forEach((row, index) => {
      if (row.change !== open) return
      for (let cursor = index - 1; cursor >= 0 && rows[cursor]?.change === 0; cursor--) keep.add(cursor)
      for (let cursor = index; cursor < rows.length && rows[cursor]?.change === 0; cursor++) keep.add(cursor)
    })
  }
  // The change each position is followed by (a band belongs to that change).
  const nextChange: (number | undefined)[] = []
  for (let index = rows.length - 1; index >= 0; index--) {
    const change = rows[index]?.change
    nextChange[index] = change === undefined || change === 0 ? nextChange[index + 1] : change
  }
  const out: SplitRow[] = []
  const gaps = new Map<number, FileGap>()
  const hunks: FileHunk[] = []
  let run: SplitRow[] | undefined
  const flush = (next?: number): void => {
    if (run === undefined) return
    const first = run[0]
    const last = run[run.length - 1]
    if (run.length <= MIN_FOLD) out.push(...run)
    else if (first !== undefined && last !== undefined) {
      gaps.set(out.length, {
        count: run.length,
        from: first.old?.number ?? first.next?.number ?? 0,
        to: last.old?.number ?? last.next?.number ?? 0,
        openedBy: next,
      })
    }
    run = undefined
  }
  rows.forEach((row, index) => {
    if (!keep.has(index)) {
      run ??= []
      run.push(row)
      return
    }
    flush(nextChange[index])
    const previous = rows[index - 1]
    if (row.change !== 0 && (previous === undefined || previous.change === 0)) {
      hunks.push({
        index: hunks.length + 1,
        row: out.length,
        line: row.next?.number ?? row.old?.number ?? 0,
        section: '',
        added: 0,
        removed: 0,
      })
    }
    const current = hunks[hunks.length - 1]
    if (current !== undefined) {
      if (row.next?.tone === 'add') current.added += 1
      if (row.old?.tone === 'del') current.removed += 1
    }
    out.push(row)
  })
  flush()
  return { rows: out, gaps, hunks }
}

/**
 * The whole file with the diff's changes laid into it (the "full file" mode).
 *
 * `fileText` is the file as it is **now** (`ctx.fs.readText`): every unchanged
 * line comes from it, so the reader sees real code, not the diff's copy of it.
 * Added lines are interleaved at their new position, deleted ones sit just
 * before the line that replaced them.
 *
 * A deleted file has no current text at all (`fileText === ''`): its rows come
 * from the diff's own text and carry old numbering, which is the only numbering
 * that file still has.
 */
export function buildFileRows(fileText: string, diffText: string): FileRow[] {
  const fileLines = splitLines(fileText)
  const rows: FileRow[] = []
  // One parse, walked in order: a hunk is "the rows until the next header".
  const parsed = parseDiff(diffText)
  const hunks = diffHunks(parsed)
  /** The line of the current file the walk has reached (1-based). */
  let line = 1
  const pushRange = (to: number): void => {
    while (line < to) {
      const text = fileLines[line - 1]
      if (text === undefined) break
      rows.push({ tone: 'context', text, number: line })
      line += 1
    }
  }
  for (const hunk of hunks) {
    // Unchanged lines before this hunk come from the file itself; a header that
    // points backwards (a malformed diff) does not rewind the walk.
    pushRange(hunk.newStart)
    // Unchanged lines are in the file **as it is now**, at their new number
    // (the old number drifts after every insertion). A deleted line is not in
    // that file at all, so the diff's own copy is the only one there is.
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (let index = hunk.row + 1; index < parsed.length; index++) {
      const row = parsed[index] as DiffLine
      if (row.tone === 'hunk') break
      if (row.tone === 'context') {
        rows.push({ tone: 'context', text: fileLines[newLine - 1] ?? row.text.slice(1), number: newLine })
        oldLine += 1
        newLine += 1
      } else if (row.tone === 'del') {
        rows.push({ tone: 'del', text: row.text.slice(1), oldNumber: oldLine })
        oldLine += 1
      } else if (row.tone === 'add') {
        rows.push({ tone: 'add', text: row.text.slice(1), number: newLine })
        newLine += 1
      }
    }
    line = Math.max(line, newLine)
  }
  pushRange(fileLines.length + 1)
  return rows
}
