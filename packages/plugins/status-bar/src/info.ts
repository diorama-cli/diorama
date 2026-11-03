/**
 * What the status bar says, as pure functions (contract.md §5.4).
 *
 * The bar itself is a React component (`index.tsx`), but everything it
 * *decides* lives here: no JSX, no React, no DOM — so `node --test` loads this
 * file directly and the rules are read without a browser (docs/m4/spec.md §12).
 *
 * Three things are worth a rule rather than a one-liner in the component:
 *
 * - **how big** a file is (bytes → the same `KiB` / `MiB` a reader sees
 *   elsewhere in the page);
 * - **when** it was last written, in the reader's own locale;
 * - **what a line count is**, which is not `split('\n').length`: every reader
 *   in this page counts lines the same way (no empty tail after a final
 *   newline), and a bar that disagreed with the gutter would be a second
 *   answer to the same question.
 */

/**
 * How large a file may be before the bar stops counting its lines (bytes).
 *
 * Counting means reading the whole file, and the bar is decoration: a 200 MB
 * log would make every tab switch read it. The size and the modification time
 * are one `stat` and stay; only the line count drops out above this.
 */
export const MAX_LINES_BYTES = 2 * 1024 * 1024

/** Bytes → `1.2 KiB` / `3.4 MiB`, the form the renderers already use. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * A modification time in the reader's locale, minute precision — the same
 * shape the history view gives a commit. An unreadable number is `undefined`
 * rather than `Invalid Date`: the bar drops the cell instead of printing it.
 */
export function formatWhen(at: number): string | undefined {
  const date = new Date(at)
  if (!Number.isFinite(at) || Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * How many lines a text has, counted the way the readers count them: a file
 * ending in a newline has no empty line after it, and an empty file has none
 * at all. `undefined` in, `undefined` out (the bar does not claim a count it
 * never read).
 */
export function countLines(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  if (text === '') return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * The bar's path cell: the mount-relative path as it is, because the mount is
 * what this page is (the directory name is already the window title,
 * contract.md §34). An empty path is the mount root, spelled `.` so the cell
 * is never blank.
 */
export function displayPath(path: string | undefined): string {
  if (path === undefined || path === '') return '.'
  return path
}

/**
 * The mount's **root** split for display (contract.md §5.4): everything up to
 * and including the last separator, and the last segment.
 *
 * The bar shows the whole path — "which directory is this page serving?" is not
 * answered by a bare `diorama` when three checkouts are called that — but the
 * last segment is what a reader scans for, so the two halves are drawn
 * differently. Splitting here (rather than in the component) keeps the rule
 * testable without React, and it handles both separators: the kernel reports a
 * POSIX path on the machine it serves, and a Windows path is the same idea with
 * `\\`.
 *
 * `/` and `C:\\` keep their separator as the name: a root with nothing after it
 * still has to say something.
 */
export function splitRoot(root: string): { parent: string; name: string } {
  const trimmed = root.replace(/[\\/]+$/, '')
  if (trimmed === '') return { parent: '', name: root }
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) return { parent: '', name: trimmed }
  return { parent: trimmed.slice(0, cut + 1), name: trimmed.slice(cut + 1) }
}
