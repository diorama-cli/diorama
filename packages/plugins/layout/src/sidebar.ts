/**
 * The left column's **folded** state (contract.md §5.2, v0.13).
 *
 * The column can be folded down to its switcher — the icons stay, the panes go
 * — the way an editor's activity bar folds a sidebar. Three things decide what
 * the column looks like, and they are deliberately three different things:
 *
 * - **which view** the column shows (`ViewChoice`, page state: a command, the
 *   switcher and the URL hash all name it);
 * - **how wide** the column is (`usePaneSize`, a preference: the reader drags
 *   the edge);
 * - **whether it is folded** (this module, also a preference: a reload comes
 *   back folded, and folding is not a view).
 *
 * Folding is **not** "choosing the view again": the reader folds the column
 * while reading a long file, unfolds it, and expects the view they had. It is
 * also not "width 0": a zero width would take the switcher with it, and then
 * nothing on the page could unfold the column again.
 *
 * The pure half lives in `.ts` on purpose: `node --test` has no JSX transform
 * (docs/m4/spec.md §12), so the rule below is testable without React.
 */

/** Where the folded state is remembered (`localStorage`, like the width). */
export const SIDEBAR_FOLDED_KEY = 'diorama.layout.sidebarFolded'

/** What the column keeps while folded: the switcher's own width (px). */
export const SIDEBAR_RAIL_PX = 36

/** A stored value that means "folded" — anything else means "open". */
const FOLDED = '1'

/**
 * The stored folded state for a page. Only the exact stored value folds the
 * column: a preference that was never written, an unreadable storage or a
 * value someone else wrote must all leave the column **open**, because a folded
 * column is the surprising state to come back to.
 */
export function readFolded(key = SIDEBAR_FOLDED_KEY): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === FOLDED
  } catch {
    return false
  }
}

/** Remember `folded`. A blocked storage only means it is not remembered. */
export function storeFolded(folded: boolean, key = SIDEBAR_FOLDED_KEY): void {
  try {
    globalThis.localStorage?.setItem(key, folded ? FOLDED : '0')
  } catch {
    // Nothing to do: the column is still folded for this page.
  }
}
