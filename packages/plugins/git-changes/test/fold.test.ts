import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collapseFileRows, labelHunks, type FileRow } from '../src/model.ts'

/** A file of `lines` lines whose line `change` is replaced by two new lines. */
function numbered(lines: number): FileRow[] {
  return Array.from({ length: lines }, (_, index) => ({ tone: 'context' as const, text: `line ${index + 1}`, number: index + 1 }))
}

test('collapseFileRows keeps the head and the neighbourhood of each change', () => {
  const rows: FileRow[] = numbered(40)
  rows[20] = { tone: 'add', text: 'inserted', number: 21 }
  const body = collapseFileRows(rows, 2, 2)
  // Head (2) + context around row 20 (rows 18..22) — everything else folds.
  assert.deepEqual(
    body.rows.map(row => row.number),
    [1, 2, 19, 20, 21, 22, 23],
  )
  assert.equal(body.gaps.size, 2)
  const first = body.gaps.get(2)
  assert.equal(first?.count, 16)
  assert.equal(first?.from, 3)
  assert.equal(first?.to, 18)
  // The band before a change belongs to it: that is the one "open" expands.
  assert.equal(first?.openedBy, 1)
  const last = body.gaps.get(7)
  assert.equal(last?.count, 17)
  assert.equal(last?.from, 24)
  assert.equal(last?.to, 40)
})

test('collapseFileRows opens the run before the change the reader asked for', () => {
  const rows: FileRow[] = numbered(40)
  rows[20] = { tone: 'add', text: 'inserted', number: 21 }
  const folded = collapseFileRows(rows, 2, 2)
  const opened = collapseFileRows(rows, 2, 2, 1)
  // The gap above the change is gone; the one after it is still folded.
  assert.ok((opened.rows.length) > folded.rows.length)
  assert.deepEqual(
    opened.rows.map(row => row.number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  )
  assert.equal(opened.gaps.size, 1)
  assert.equal(opened.gaps.get(opened.rows.length)?.from, 24)
})

test('collapseFileRows names each change and counts what it does', () => {
  const rows: FileRow[] = [
    ...numbered(4),
    { tone: 'del', text: 'old', oldNumber: 5 },
    { tone: 'add', text: 'new a', number: 5 },
    { tone: 'add', text: 'new b', number: 6 },
    { tone: 'context', text: 'line 6', number: 7 },
  ]
  const body = collapseFileRows(rows, 0, 0)
  assert.equal(body.hunks.length, 1)
  // The deleted line has no current number: the change is anchored where the
  // line it replaced used to be.
  assert.deepEqual(body.hunks[0], { index: 1, row: 0, line: 5, section: '', added: 2, removed: 1 })
})

test('collapseFileRows keeps short runs open, and folds nothing when there is nothing to fold', () => {
  const body = collapseFileRows(numbered(3))
  assert.equal(body.gaps.size, 0)
  assert.deepEqual(
    body.rows.map(row => row.number),
    [1, 2, 3],
  )
})

test('labelHunks takes the section names from the diff headers, in order', () => {
  const rows: FileRow[] = numbered(30)
  rows[5] = { tone: 'add', text: 'x', number: 6 }
  rows[20] = { tone: 'add', text: 'y', number: 21 }
  const body = collapseFileRows(rows, 1, 0)
  const labelled = labelHunks(body, ['@@ -1,2 +1,3 @@ function first()', 'x', '---', '+++', '@@ -20,1 +21,2 @@ class Second'].join('\n'))
  assert.deepEqual(
    labelled.hunks.map(hunk => [hunk.index, hunk.section]),
    [
      [1, 'function first()'],
      [2, 'class Second'],
    ],
  )
})
