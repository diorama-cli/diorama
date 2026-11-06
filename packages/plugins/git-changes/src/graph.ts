/**
 * The commit graph of the history view (contract.md §5.2): which lane
 * every commit sits in, and which lines cross the row between it and the next.
 *
 * The view draws this; the kernel only supplies `parents` on each `GitLogEntry`
 * (contract.md §3.2). Lanes are columns, one commit per row, newest first — so a
 * line runs from a child's dot down to its parent's dot, and a branch is two
 * lanes side by side.
 *
 * The layout is a pure function over the page of commits the view holds, not
 * over the whole history: a parent that is not in the page simply leaves its
 * lane open, and the last row draws that lane to its bottom edge ("there is
 * more below", which is what "加载更多" says in words).
 */

/** One commit as the graph needs it (contract.md §3.2's `GitLogEntry`). */
export interface GraphCommit {
  sha: string
  /**
   * The parents, first parent first. Absent means "not reported": the next
   * commit in the list is taken as the parent, which is what a straight page of
   * history is.
   */
  parents?: readonly string[]
}

/** One line crossing a row: a lane at the top edge to a lane at the bottom. */
export interface GraphLine {
  /** The lane at the start of the segment. */
  from: number
  /** The lane at its end. */
  to: number
  /** Palette index (0..GRAPH_COLORS-1) — the colour follows the lane's origin. */
  color: number
  /**
   * How much of the row's height the segment covers: `'full'` top to bottom (a
   * lane passing through), `'top'` down to the dot (this row's commit was
   * awaited), `'bottom'` from the dot to the bottom edge (a parent leaves it).
   */
  span: 'full' | 'top' | 'bottom'
}

/** One row of the graph: the commit's dot and the lines around it. */
export interface GraphRow {
  sha: string
  /** The commit's column. */
  lane: number
  /** The dot's palette index. */
  color: number
  lines: GraphLine[]
}

export interface GraphLayout {
  rows: GraphRow[]
  /** How many lanes the widest row uses (at least 1). */
  lanes: number
}

/** How many colours the palette has (`--dio-graph-1` … in the stylesheet). */
export const GRAPH_COLORS = 6

/**
 * Lay a page of commits out. `commits` is newest first, the order `git log`
 * reports; the result has one row per commit, in the same order.
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphLayout {
  /** The commit each lane is waiting for, or `null` when the lane is free. */
  const lanes: (string | null)[] = []
  /** The palette index of each lane's line. */
  const colors: number[] = []
  let nextColor = 0
  const rows: GraphRow[] = []

  const claim = (sha: string, lane: number): void => {
    lanes[lane] = sha
    colors[lane] = nextColor
    nextColor = (nextColor + 1) % GRAPH_COLORS
  }
  const freeLane = (): number => {
    const at = lanes.indexOf(null)
    return at === -1 ? lanes.length : at
  }

  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index] as GraphCommit
    const next = commits[index + 1]
    const parents = commit.parents ?? (next === undefined ? [] : [next.sha])
    // The lane something already pointed at this commit in, or a fresh one for a
    // commit nothing points at (the newest one, or the first of a page).
    let lane = lanes.indexOf(commit.sha)
    // Something above pointed at this commit, so a line reaches it from above.
    // A commit nothing pointed at (the newest one, or the first of a page) has
    // no line over its dot.
    const awaited = lane !== -1
    if (lane === -1) {
      lane = freeLane()
      claim(commit.sha, lane)
    }
    // Above the dot: the lanes that were waiting for something. The row's own
    // lane stops at the dot; a lane that waited for *this* commit (a
    // criss-cross: two children, one parent) ends on it; the rest run through.
    const lines: GraphLine[] = []
    for (let i = 0; i < lanes.length; i++) {
      const waiting = lanes[i]
      if (waiting === null || waiting === undefined) continue
      if (i === lane) {
        if (awaited) lines.push({ from: i, to: i, color: colors[i] as number, span: 'top' })
      } else {
        lines.push({ from: i, to: i, color: colors[i] as number, span: 'full' })
      }
    }
    // Below the dot: where each parent goes. The first parent keeps the lane
    // when nothing else is waiting for it, so a straight history is one
    // straight line down the column.
    for (let which = 0; which < parents.length; which++) {
      const parent = parents[which] as string
      if (which === 0) {
        const elsewhere = lanes.findIndex((sha, i) => i !== lane && sha === parent)
        if (elsewhere !== -1) {
          lines.push({ from: lane, to: elsewhere, color: colors[lane] as number, span: 'bottom' })
          lanes[lane] = null
        } else {
          lanes[lane] = parent
          lines.push({ from: lane, to: lane, color: colors[lane] as number, span: 'bottom' })
        }
        continue
      }
      const known = lanes.indexOf(parent)
      if (known !== -1) {
        lines.push({ from: lane, to: known, color: colors[lane] as number, span: 'bottom' })
        continue
      }
      const target = freeLane()
      claim(parent, target)
      lines.push({ from: lane, to: target, color: colors[target] as number, span: 'bottom' })
    }
    if (parents.length === 0) lanes[lane] = null
    rows.push({ sha: commit.sha, lane, color: colors[lane] as number, lines })
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      colors.pop()
    }
  }

  // A lane still waiting when the page runs out is a parent below what is
  // loaded. It has to reach the bottom edge of the **last** row, or the line
  // stops at a row boundary and reads as a dead end rather than "there is more
  // below". (The lanes that ran through earlier rows already end at that
  // boundary; this gives the last row the segment that says so.)
  const last = rows[rows.length - 1]
  if (last !== undefined) {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null || lanes[i] === undefined) continue
      const drawn = last.lines.some(line => line.span === 'bottom' && line.from === i)
      if (!drawn) last.lines.push({ from: i, to: i, color: colors[i] as number, span: 'bottom' })
    }
  }

  let widest = 1
  for (const row of rows) {
    widest = Math.max(widest, row.lane + 1)
    for (const line of row.lines) widest = Math.max(widest, line.from + 1, line.to + 1)
  }
  return { rows, lanes: widest }
}
