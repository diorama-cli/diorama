import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSplitRows, collapseSplitRows } from '../src/model.ts'

/** Two lines replaced by one, with the file around them unchanged. */
const DIFF = [
  '@@ -1,4 +1,3 @@',
  ' one',
  '-two',
  '-three',
  '+TWO',
  ' four',
].join('\n')

test('buildSplitRows pairs a change\'s deletions with its insertions', () => {
  const rows = buildSplitRows('one\nTWO\nfour\n', DIFF)
  assert.deepEqual(
    rows.map(row => [row.old?.text, row.next?.text, row.change]),
    [
      ['one', 'one', 0],
      ['two', 'TWO', 1],
      ['three', undefined, 1],
      ['four', 'four', 0],
    ],
  )
  // Each column keeps its own file's numbering.
  assert.deepEqual(
    rows.map(row => [row.old?.number, row.next?.number]),
    [
      [1, 1],
      [2, 2],
      [3, undefined],
      [4, 3],
    ],
  )
})

test('buildSplitRows leaves the side that has no line blank', () => {
  // A pure insertion: the old side is empty on that row.
  const diff = ['@@ -1,1 +1,3 @@', ' a', '+b', '+c'].join('\n')
  const rows = buildSplitRows('a\nb\nc\n', diff)
  assert.deepEqual(
    rows.map(row => [row.old?.text, row.next?.text]),
    [
      ['a', 'a'],
      [undefined, 'b'],
      [undefined, 'c'],
    ],
  )
})

test('buildSplitRows takes unchanged lines from the file, not from the hunk', () => {
  // The diff's copy of an unchanged line is only the context git printed; the
  // file is the truth for everything outside the hunks.
  const diff = ['@@ -2,1 +2,1 @@', '-b', '+B'].join('\n')
  const rows = buildSplitRows('a\nB\nc\nd\n', diff)
  assert.deepEqual(
    rows.map(row => [row.old?.text, row.next?.text]),
    [
      ['a', 'a'],
      ['b', 'B'],
      ['c', 'c'],
      ['d', 'd'],
    ],
  )
})

test('buildSplitRows still aligns a deleted file, whose lines only exist in the diff', () => {
  const diff = ['@@ -1,2 +0,0 @@', '-gone', '-too'].join('\n')
  const rows = buildSplitRows('', diff)
  assert.deepEqual(
    rows.map(row => [row.old?.text, row.next?.text]),
    [
      ['gone', undefined],
      ['too', undefined],
    ],
  )
})

test('collapseSplitRows folds a rectangle of both columns and opens one change', () => {
  const file = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
  const changed = file.map(line => (line === 'line 20' ? 'line twenty' : line))
  const diff = [
    '@@ -17,7 +17,7 @@',
    ...file.slice(16, 19).map(line => ` ${line}`),
    '-line 20',
    '+line twenty',
    ...file.slice(20, 23).map(line => ` ${line}`),
  ].join('\n')
  const rows = buildSplitRows(changed.join('\n'), diff)
  const folded = collapseSplitRows(rows, 3, 2)
  assert.equal(folded.hunks.length, 1)
  assert.equal(folded.gaps.size, 2)
  // The band before the change belongs to it, and says which lines it hides.
  const first = folded.gaps.get(2)
  assert.equal(first?.from, 3)
  assert.equal(first?.to, 16)
  assert.equal(first?.openedBy, 1)
  // Opening that change shows the lines above it.
  const opened = collapseSplitRows(rows, 3, 2, 1)
  assert.ok(opened.rows.length > folded.rows.length)
  assert.equal(opened.gaps.size, 1)
})
