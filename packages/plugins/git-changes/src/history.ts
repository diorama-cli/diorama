/**
 * The history view's own state, as pure functions (contract.md §3.8, §5.2).
 *
 * The view keeps what the reader picked in the URL hash (`#history=…`), and
 * that value is the only thing the seat and a refreshed page read. Encoding it,
 * decoding it and deciding what one more click does are decisions, not
 * rendering — so they live here, where `node --test` can reach them (a
 * `.tsx` file cannot be imported by the unit tests).
 *
 * ## The value (v0.6, v0.10, v0.25)
 *
 * `<repo>:<sha>` when the commit is in a repository below the mount root, the
 * bare sha when it is in the mount's own repository, and `''` for "the history
 * view is open, nothing picked". A mount may hold several repositories
 * (v0.10) and the same sha is a different commit in each, so the repository is
 * part of the value; repository paths contain `/` but never `:`, so the first
 * `:` is the separator.
 *
 * v0.25 adds **several** commits of that repository, comma separated and
 * written **oldest first** (`<repo>:<oldest>,…,<newest>`). A sha holds no
 * comma, so nothing needs escaping, and a value with one commit decodes to
 * exactly the shape it always had.
 */

/** A history hash value split into its repository and commit(s). */
export interface PickedCommit {
  /** The repository's mount-relative path (`''` = the mount's own repository). */
  repo: string
  /** The newest commit of the pick, as the history row spells it (a full sha). */
  commit: string
  /**
   * Every picked commit, oldest first. Absent when one commit is picked — that
   * is every value a v0.6–v0.24 page wrote.
   */
  commits?: string[]
}

/** Encode a picked commit (or several, oldest first) for `#history`. */
export function historyHashValue(repo: string, commits: readonly string[]): string {
  const joined = commits.join(',')
  return repo === '' ? joined : `${repo}:${joined}`
}

/** Decode a `#history` value; `undefined` for the empty (or absent) value. */
export function parseHistoryHash(value: string | undefined): PickedCommit | undefined {
  if (value === undefined || value === '') return undefined
  // A repository path never holds `:`, so the first one separates; a value
  // that *starts* with one names no repository (a mount path is never empty
  // before the separator, but a malformed value can be).
  const at = value.indexOf(':')
  const repo = at === -1 ? '' : value.slice(0, at)
  const commits = (at === -1 ? value : value.slice(at + 1)).split(',').filter(part => part !== '')
  const newest = commits[commits.length - 1]
  if (newest === undefined) return undefined
  // One commit decodes to exactly the shape it always had (no `commits` key),
  // so nothing downstream has to know about a pick of several unless it wants to.
  return commits.length === 1 ? { repo, commit: newest } : { repo, commit: newest, commits }
}

/** What a click on a commit row leaves behind. */
export interface RangeChoice {
  /** The commits now picked, **oldest first**; empty = nothing picked. */
  commits: string[]
  /**
   * Where the next Shift-click starts from — the row that was clicked last
   * (a Shift-click keeps it, so the range grows from the same anchor).
   */
  anchor: string | undefined
}

/** How a row was clicked. */
export interface RowClick {
  /** Shift held: pick the whole stretch from the anchor to this row. */
  shift?: boolean
  /** ⌘ / Ctrl held: add this row to the pick, or take it out. */
  toggle?: boolean
}

/**
 * What clicking a commit row does to the pick (v0.25) — the selection rules
 * every list in an editor has, so nothing has to be learned:
 *
 * - a plain click picks **just that row** (replacing whatever was picked);
 * - **Shift**-click picks the **whole stretch** from the anchor (the row
 *   clicked last) to this one, both ends included;
 * - **⌘ / Ctrl**-click adds this row, or takes it out when it is already in.
 *
 * `order` is the list as drawn — **newest first** — so a larger index is an
 * older commit; the answer is always ordered oldest → newest, because that is
 * the direction the diff is read in.
 */
export function pickCommits(
  chosen: readonly string[],
  anchor: string | undefined,
  sha: string,
  order: readonly string[],
  click: RowClick = {},
): RangeChoice {
  const rank = new Map(order.map((item, index) => [item, index]))
  const oldestFirst = (list: readonly string[]): string[] =>
    [...new Set(list)].sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0))

  if (click.toggle === true) {
    const next = chosen.includes(sha) ? chosen.filter(item => item !== sha) : [...chosen, sha]
    return { commits: oldestFirst(next), anchor: sha }
  }
  const from = anchor === undefined ? undefined : rank.get(anchor)
  const to = rank.get(sha)
  // A Shift-click needs a row to stretch *from*: without an anchor (a fresh
  // page, a reload) it is an ordinary click.
  if (click.shift === true && from !== undefined && to !== undefined) {
    const low = Math.min(from, to)
    return { commits: oldestFirst(order.slice(low, Math.max(from, to) + 1)), anchor }
  }
  return { commits: [sha], anchor: sha }
}
