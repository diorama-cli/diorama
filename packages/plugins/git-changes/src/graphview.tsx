/**
 * The history view's commit graph (contract.md §5.2): a lane per branch,
 * a dot per commit, and a line from each commit down to its parents.
 *
 * Geometry lives in `graph.ts` (a pure function, unit-tested); this file only
 * turns it into SVG. The drawing is deliberately simple: vertical runs are
 * straight, a parent in another lane is a curve, and the lane's colour is fixed
 * per lane so a branch is one colour from top to bottom.
 */
import type { CSSProperties, ReactElement } from 'react'
import { GRAPH_COLORS, type GraphLine, type GraphRow } from './graph.ts'

/** Width of one lane (px). The column is `lanes × this`. */
export const GRAPH_LANE_PX = 12

/** The dot's radius (px). */
export const GRAPH_DOT_PX = 3.5

/** The SVG's vertical coordinate system: `0` top edge, `50` the dot, `100` bottom. */
const MID = 50
const BOTTOM = 100

/** The colour token of a palette index. */
export function graphColor(index: number): string {
  return `var(--dio-graph-${(index % GRAPH_COLORS) + 1})`
}

/** The middle of a lane, in lane units (the SVG's x coordinate). */
function laneX(lane: number): number {
  return lane + 0.5
}

/** The path of one line segment, in the SVG's `0..lanes × 0..100` box. */
export function linePath(line: GraphLine): string {
  const x1 = laneX(line.from)
  const x2 = laneX(line.to)
  const y1 = line.span === 'bottom' ? MID : 0
  const y2 = line.span === 'top' ? MID : BOTTOM
  if (x1 === x2) return `M ${x1} ${y1} L ${x1} ${y2}`
  // A parent in another lane: leave the dot, cross, arrive. The control points
  // sit at the middle of the vertical run, so the curve leaves and arrives
  // vertically and never looks like a diagonal.
  const midY = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
}

/** One row's lines: the runs above and below its dot. */
function RowLines({ row, lanes }: { row: GraphRow; lanes: number }): ReactElement {
  return (
    <svg
      className="diorama-graph__lines"
      viewBox={`0 0 ${lanes} ${BOTTOM}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {row.lines.map((line, index) => (
        <path
          key={`${line.from}:${line.to}:${line.span}:${index}`}
          className="diorama-graph__line"
          data-testid="git-history-line"
          d={linePath(line)}
          stroke={graphColor(line.color)}
          vectorEffect="non-scaling-stroke"
          fill="none"
        />
      ))}
    </svg>
  )
}

/** The graph column of one history row: its lines and its dot. */
export function HistoryGraph({ row, lanes }: { row: GraphRow; lanes: number }): ReactElement {
  const style: CSSProperties = { width: lanes * GRAPH_LANE_PX }
  return (
    <span className="diorama-graph" style={style} data-testid="git-history-graph" data-lanes={lanes} aria-hidden="true">
      <RowLines row={row} lanes={lanes} />
      <span
        className="diorama-graph__dot"
        data-testid="git-history-dot"
        data-sha={row.sha}
        data-lane={row.lane}
        data-color={row.color}
        style={{ left: (row.lane + 0.5) * GRAPH_LANE_PX, background: graphColor(row.color) }}
      />
    </span>
  )
}
