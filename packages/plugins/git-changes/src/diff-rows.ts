/**
 * How the gestures find a line in each diff reader (contract.md §3.12).
 *
 * The rows of a diff are **not** the text renderers' rows: there are three
 * readers with three shapes, and only some rows address a line of the file as
 * it is now:
 *
 * - the inline reader's cell holds git's own line, prefix and all, so the
 *   column has to drop that one character (`trim: 1`);
 * - the whole-file reader's cell holds the file's text, and a deleted row
 *   carries `oldNumber` only — a line the file does not have;
 * - the side-by-side reader's two cells are the old and the new file, so the
 *   left one is not addressable at all (only `data-new-line` counts).
 *
 * A row with no current-file number therefore has no `data-new-line` attribute,
 * and a gesture over it quietly finds nothing: asking the server about "line
 * 12" while the reader is looking at a deleted line 12 would answer about a
 * different line entirely.
 *
 * Pure data in a `.ts` module so `node --test` can pin it — a `.tsx` cannot be
 * imported by the test runner (docs/m4/spec.md §12).
 */
import type { RowGeometry } from 'diorama-ui'

/** The inline reader: git's line, one prefix character to drop. */
export const INLINE_ROWS: RowGeometry = { lineAttribute: 'data-new-line', cellSelector: '.diorama-diff__code', trim: 1 }

/** The whole-file reader: the file's own text, no prefix. */
export const FILE_ROWS: RowGeometry = { lineAttribute: 'data-new-line', cellSelector: '.diorama-diff__code' }

/** The side-by-side reader: only the new column is addressable. */
export const SPLIT_ROWS: RowGeometry = { lineAttribute: 'data-new-line', cellSelector: '.diorama-diff__code' }
