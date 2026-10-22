import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildFileRows,
  diffHunks,
  diffStat,
  diffTone,
  parseDiff,
  parseHunkHeader,
  splitLines,
} from '../src/model.ts'

/** A three-line file with one line changed, as git prints it. */
const CHANGED = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,4 @@ function hi()',
  ' one',
  '-TWO',
  '+two',
  '+TWO!',
  ' three',
  '',
].join('\n')

test('splitLines drops the trailing newline without dropping blank lines', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b'])
  assert.deepEqual(splitLines(''), [])
})

test('diffTone colours headers, hunks, additions, deletions and context', () => {
  assert.equal(diffTone('diff --git a/x b/x'), 'meta')
  assert.equal(diffTone('index 1..2'), 'meta')
  assert.equal(diffTone('--- a/x'), 'meta')
  assert.equal(diffTone('+++ b/x'), 'meta')
  assert.equal(diffTone('@@ -1 +1 @@'), 'hunk')
  assert.equal(diffTone('+added'), 'add')
  assert.equal(diffTone('-deleted'), 'del')
  assert.equal(diffTone(' context'), 'context')
  assert.equal(diffTone(''), 'context')
})

test('parseHunkHeader reads both ranges, and the section after them', () => {
  assert.deepEqual(parseHunkHeader('@@ -1,3 +1,4 @@ function hi()'), {
    section: 'function hi()',
    oldStart: 1,
    oldCount: 3,
    newStart: 1,
    newCount: 4,
  })
  // git's shorthand: one line is written without a count.
  assert.deepEqual(parseHunkHeader('@@ -7 +9 @@'), {
    section: '',
    oldStart: 7,
    oldCount: 1,
    newStart: 9,
    newCount: 1,
  })
  // A pure insertion after the last line: `-0,0`.
  assert.deepEqual(parseHunkHeader('@@ -12,0 +13,2 @@'), {
    section: '',
    oldStart: 12,
    oldCount: 0,
    newStart: 13,
    newCount: 2,
  })
  assert.equal(parseHunkHeader('not a hunk'), undefined)
})

test('parseDiff numbers both sides and tags rows with their hunk', () => {
  const rows = parseDiff(CHANGED)
  assert.deepEqual(
    rows.map(row => [row.tone, row.oldLine, row.newLine]),
    [
      ['meta', undefined, undefined],
      ['meta', undefined, undefined],
      ['meta', undefined, undefined],
      ['meta', undefined, undefined],
      ['hunk', undefined, undefined],
      ['context', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['context', 3, 4],
    ],
  )
  assert.deepEqual(
    rows.map(row => row.hunk),
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
  )
})

test('parseDiff keeps a malformed header from derailing the numbers', () => {
  const rows = parseDiff(['@@ -1,1 +1,1 @@', ' one'].join('\n'))
  assert.equal(rows[0]?.tone, 'hunk')
  assert.equal(rows[1]?.oldLine, 1)
  assert.equal(rows[1]?.newLine, 1)
})

test('diffHunks gives each change its range and its row, in file order', () => {
  const text = [
    '@@ -1,2 +1,2 @@ one',
    '-a',
    '+A',
    ' b',
    '@@ -10,2 +10,3 @@ two',
    ' c',
    '+new',
    ' d',
  ].join('\n')
  const rows = parseDiff(text)
  const hunks = diffHunks(rows)
  assert.equal(hunks.length, 2)
  assert.deepEqual(hunks[0], {
    index: 1,
    header: '@@ -1,2 +1,2 @@ one',
    section: 'one',
    oldStart: 1,
    oldCount: 2,
    newStart: 1,
    newCount: 2,
    row: 0,
  })
  assert.equal(hunks[1]?.row, 4)
  assert.equal(hunks[1]?.newCount, 3)
})

test('diffStat counts what the header shows', () => {
  assert.deepEqual(diffStat(parseDiff(CHANGED)), { added: 2, removed: 1, hunks: 1 })
  assert.deepEqual(diffStat([]), { added: 0, removed: 0, hunks: 0 })
})

test('buildFileRows lays the changes into the file, with real code around them', () => {
  // The file as it is now: the change is on line 2, and the added lines follow.
  const rows = buildFileRows('one\ntwo\nTWO!\nthree\n', CHANGED)
  assert.deepEqual(
    rows.map(row => [row.tone, row.number, row.text]),
    [
      ['context', 1, 'one'],
      ['del', undefined, 'TWO'],
      ['add', 2, 'two'],
      ['add', 3, 'TWO!'],
      ['context', 4, 'three'],
    ],
  )
  assert.equal(rows[1]?.oldNumber, 2)
})

test('buildFileRows fills the gap between hunks from the file itself', () => {
  const diff = [
    '@@ -1,1 +1,1 @@',
    '-a',
    '+A',
    '@@ -9,1 +9,2 @@',
    ' i',
    '+j',
  ].join('\n')
  const file = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
  const rows = buildFileRows(file, diff)
  // The replaced line is still shown (as a deletion) just above its successor.
  assert.deepEqual(
    rows.map(row => row.text),
    ['a', 'A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
  )
  // Untouched lines keep their real numbers; the added one takes the next.
  assert.deepEqual(
    rows.map(row => row.number),
    [undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  )
  assert.equal(rows.filter(row => row.tone === 'del').length, 1)
  assert.equal(rows.filter(row => row.tone === 'add').length, 2)
})

test('buildFileRows falls back to the diff for a deleted file', () => {
  // A deleted file has no text of its own any more: the old side is the diff's.
  const diff = ['@@ -1,2 +0,0 @@', '-gone', '-too'].join('\n')
  const rows = buildFileRows('', diff)
  assert.deepEqual(
    rows.map(row => [row.tone, row.oldNumber, row.text]),
    [
      ['del', 1, 'gone'],
      ['del', 2, 'too'],
    ],
  )
})

test('buildFileRows leaves a file with no diff untouched', () => {
  const rows = buildFileRows('one\ntwo\n', '')
  assert.deepEqual(
    rows.map(row => [row.tone, row.number, row.text]),
    [
      ['context', 1, 'one'],
      ['context', 2, 'two'],
    ],
  )
})
