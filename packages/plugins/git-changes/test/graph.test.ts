import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GRAPH_COLORS, layoutGraph, type GraphLine } from '../src/graph.ts'

/**
 * The commit graph's layout (contract.md §5.2): lanes, dots and the
 * lines between rows. Pure arithmetic over the page `log()` returned, so it is
 * tested without a browser.
 *
 * The invariant every test leans on: **adjacent rows meet**. Whatever leaves a
 * row's bottom edge has to arrive at the next row's top edge at the same lane,
 * or the picture has floating lines.
 */

/** A straight page of history: each commit's parent is the next one. */
function straight(count: number): { sha: string; parents: string[] }[] {
  return Array.from({ length: count }, (_, index) => ({
    sha: `c${index}`,
    parents: index + 1 < count ? [`c${index + 1}`] : [],
  }))
}

/** The lane a segment sits in at the row's top edge (its start). */
function topLane(line: GraphLine): number | undefined {
  return line.span === 'top' || line.span === 'full' ? line.from : undefined
}

/** The lane a segment sits in at the row's bottom edge (its end). */
function bottomLane(line: GraphLine): number | undefined {
  return line.span === 'bottom' || line.span === 'full' ? line.to : undefined
}

/**
 * The lanes crossing the edge between two rows. A set, not a list: two lines
 * that meet at a dot leave the upper row at the same lane they arrive in, and
 * the crossing itself is drawn once on the row's bottom edge.
 */
function assertJoined(upper: { lines: GraphLine[] }, lower: { lines: GraphLine[] }): void {
  const leaving = new Set(upper.lines.map(bottomLane).filter((lane): lane is number => lane !== undefined))
  const arriving = new Set(lower.lines.map(topLane).filter((lane): lane is number => lane !== undefined))
  assert.deepEqual([...leaving].sort(), [...arriving].sort())
}

test('graph: a straight history is one lane, joined row to row', () => {
  const layout = layoutGraph(straight(4))
  assert.equal(layout.lanes, 1)
  assert.deepEqual(layout.rows.map(row => row.lane), [0, 0, 0, 0])
  // Nothing above the newest commit; the oldest has no line below it.
  assert.deepEqual(layout.rows[0]?.lines.map(line => line.span), ['bottom'])
  assert.deepEqual(layout.rows[1]?.lines.map(line => line.span).sort(), ['bottom', 'top'])
  assert.deepEqual(layout.rows[3]?.lines.map(line => line.span), ['top'])
  for (let i = 0; i + 1 < layout.rows.length; i++) assertJoined(layout.rows[i]!, layout.rows[i + 1]!)
})

test('graph: a merge puts the branch in a second lane and joins it at the dot', () => {
  // c0 (the merge) has two parents: c1 on the main line and c2 on the branch.
  const layout = layoutGraph([
    { sha: 'c0', parents: ['c1', 'c2'] },
    { sha: 'c1', parents: ['c3'] },
    { sha: 'c2', parents: ['c3'] },
    { sha: 'c3', parents: [] },
  ])
  assert.equal(layout.lanes, 2)
  // The merge commit sits in lane 0; its second parent opens lane 1.
  assert.equal(layout.rows[0]?.lane, 0)
  const below = layout.rows[0]?.lines.filter(line => line.span === 'bottom') ?? []
  assert.equal(below.length, 2)
  assert.deepEqual(below.map(line => line.to).sort(), [0, 1])
  // The branch commit is in lane 1 and its parent is back in lane 0.
  assert.equal(layout.rows[2]?.lane, 1)
  const branch = layout.rows[2]?.lines.find(line => line.span === 'bottom')
  assert.equal(branch?.from, 1)
  assert.equal(branch?.to, 0)
  // Both lines reach c3: lane 0 runs straight down, lane 1 leaves the branch
  // commit's dot and crosses into lane 0 on its own row's bottom edge.
  const arriving = layout.rows[3]?.lines.filter(line => line.span === 'top') ?? []
  assert.ok(arriving.every(line => line.to === layout.rows[3]?.lane))
  const crossing = layout.rows[2]?.lines.find(line => line.span === 'bottom')
  assert.deepEqual([crossing?.from, crossing?.to], [1, 0])
  for (let i = 0; i + 1 < layout.rows.length; i++) assertJoined(layout.rows[i]!, layout.rows[i + 1]!)
})

test('graph: a lane whose parent is not loaded runs off the bottom edge', () => {
  // The page stops after a commit whose parent is older than what is loaded:
  // the last row still has a line leaving it, so the reader sees "more below".
  const layout = layoutGraph([
    { sha: 'c0', parents: ['c1'] },
    { sha: 'c1', parents: ['c2'] },
  ])
  const last = layout.rows[1]
  assert.ok(last?.lines.some(line => line.span === 'bottom' && line.from === 0 && line.to === 0))
})

test('graph: two children of one commit (criss-cross) join on its dot', () => {
  // c0 and c1 both point at c2: the line from c0's lane crosses over to the
  // lane c2 ends up in, and both lines meet at c2's dot.
  const layout = layoutGraph([
    { sha: 'c0', parents: ['c2'] },
    { sha: 'c1', parents: ['c2'] },
    { sha: 'c2', parents: [] },
  ])
  assert.equal(layout.lanes, 2)
  const arriving = layout.rows[2]?.lines.filter(line => line.span === 'top') ?? []
  assert.ok(arriving.every(line => line.to === layout.rows[2]?.lane))
  // c1's line crosses from its own lane into c2's on c1's bottom edge.
  const crossing = layout.rows[1]?.lines.find(line => line.span === 'bottom')
  assert.deepEqual([crossing?.from, crossing?.to], [1, 0])
  for (let i = 0; i + 1 < layout.rows.length; i++) assertJoined(layout.rows[i]!, layout.rows[i + 1]!)
})

test('graph: a commit with no reported parents follows the list', () => {
  // `parents` absent: the next commit is the parent (a page of `git log`).
  const layout = layoutGraph([{ sha: 'c0' }, { sha: 'c1' }, { sha: 'c2' }])
  assert.equal(layout.lanes, 1)
  assert.deepEqual(layout.rows.map(row => row.lane), [0, 0, 0])
  // The oldest commit of the page is the end of the line: no line below it.
  assert.ok(!layout.rows[2]?.lines.some(line => line.span === 'bottom'))
})

test('graph: lanes are recycled once their line ends', () => {
  // c0 and c1 both point at c3, which is not in the page: lane 0 stays open for
  // it, lane 1 closes when c1's line crosses into lane 0. A commit that starts
  // a line of its own (c2, with no parents) therefore takes lane 1 — the first
  // lane nobody is waiting in — instead of widening the graph to three.
  const layout = layoutGraph([
    { sha: 'c0', parents: ['c3'] },
    { sha: 'c1', parents: ['c3'] },
    { sha: 'c2', parents: [] },
  ])
  assert.equal(layout.lanes, 2)
  assert.equal(layout.rows[2]?.lane, 1)
})

test('graph: colours are a palette index in range', () => {
  const commits = Array.from({ length: 12 }, (_, index) => ({
    sha: `c${index}`,
    parents: index + 1 < 12 ? [`c${index + 1}`, `c${index + 1}`] : [],
  }))
  const layout = layoutGraph(commits)
  for (const row of layout.rows) {
    assert.ok(row.color >= 0 && row.color < GRAPH_COLORS)
    for (const line of row.lines) assert.ok(line.color >= 0 && line.color < GRAPH_COLORS)
  }
})

test('graph: no commits is an empty graph, not a broken one', () => {
  const layout = layoutGraph([])
  assert.deepEqual(layout.rows, [])
  assert.equal(layout.lanes, 1)
})

test('graph: a page whose parents are all present never leaves a line hanging', () => {
  // The shape the history view actually gets from log() (docs/m34/spec.md §8):
  // a branch merged into a main line, every commit present. Every line that
  // leaves a row has to arrive somewhere — no dead ends inside the page.
  const commits = [
    { sha: 'F', parents: ['E'] },
    { sha: 'E', parents: ['B', 'D'] },
    { sha: 'B', parents: ['A'] },
    { sha: 'D', parents: ['A'] },
    { sha: 'A', parents: [] },
  ]
  const layout = layoutGraph(commits)
  const index = new Map(commits.map((commit, at) => [commit.sha, at]))
  for (let row = 0; row < layout.rows.length; row++) {
    const lines = layout.rows[row]!.lines
    for (const line of lines) {
      if (line.span !== 'bottom') continue
      // A bottom segment must be picked up by the next row — unless this is the
      // last row, where "off the bottom edge" is the honest answer.
      if (row + 1 < layout.rows.length) {
        const next = layout.rows[row + 1]!.lines
        assert.ok(
          next.some(other => other.to === line.to && (other.span === 'top' || other.span === 'full')),
          `row ${row} leaves lane ${line.to} open but row ${row + 1} does not receive it`,
        )
      }
    }
  }
  // Both branches are drawn, and they meet at A.
  assert.equal(layout.lanes, 2)
  assert.ok(index.has('A'))
})

test('graph: an open lane reaches the last row\'s bottom edge', () => {
  // The page stops before the parent is reached (a paged history, or a
  // pathspec-filtered one). The lane must run to the **bottom edge of the last
  // row**: stopping at a row boundary reads as a dead end, not as "more below".
  const layout = layoutGraph([
    { sha: 'c0', parents: ['c1'] },
    { sha: 'c1', parents: ['c2'] },
  ])
  const last = layout.rows[layout.rows.length - 1]!
  assert.ok(
    last.lines.some(line => line.span === 'bottom' && line.from === 0 && line.to === 0),
    'the lane still waiting for c2 must leave the last row at its bottom edge',
  )
})

test('graph: a parent that is not in the page leaves no line pointing at nothing', () => {
  // The historical bug (docs/m34/spec.md §8): log() dropped the merge commit,
  // so a child named a parent that had no row. Nothing may be drawn towards a
  // row that does not exist — the lane either continues to the bottom edge of
  // the page or ends at a dot that is there.
  const layout = layoutGraph([
    { sha: 'F', parents: ['E'] },
    { sha: 'C', parents: ['B'] },
    { sha: 'B', parents: ['A'] },
    { sha: 'A', parents: [] },
  ])
  const present = new Set(layout.rows.map(row => row.sha))
  // E is missing: F's lane stays open and runs off the bottom of the page.
  assert.ok(!present.has('E'))
  const lanesAtBottom = layout.rows[layout.rows.length - 1]!.lines.filter(line => line.span === 'bottom')
  assert.ok(lanesAtBottom.length >= 1, 'an open lane has to be drawn to the bottom edge')
})
