/**
 * The selection slices of a row-per-line reader (contract.md §3.11).
 *
 * Pure arithmetic only: which rows a DOM selection covers, and how much of
 * each. The painting itself lives in `selection.ts` (it needs a DOM); the rule
 * that "a row selected to its last character is a full block" is what makes a
 * multi-line selection read as one block instead of a strip per line.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { selectionSlices } from '../src/selection.ts'

/** Lengths of the rows under test: line 1 is "abc", line 2 "hello world", line 3 "". */
const lengths = new Map<number, number>([
  [1, 3],
  [2, 11],
  [3, 0],
])

test('selectionSlices: a row covered to its last character is a full block', () => {
  const slices = selectionSlices([{ line: 2, start: 0, end: 10 }], lengths)
  assert.deepEqual(slices, [{ line: 2, start: 0, end: 10, full: true }])
})

test('selectionSlices: a row covered in part is a run, not a block', () => {
  const slices = selectionSlices([{ line: 2, start: 3, end: 7 }], lengths)
  assert.deepEqual(slices, [{ line: 2, start: 3, end: 7, full: false }])
})

test('selectionSlices: several rows come back in line order', () => {
  const slices = selectionSlices(
    [
      { line: 3, start: 0, end: 0 },
      { line: 1, start: 1, end: 2 },
      { line: 2, start: 0, end: 10 },
    ],
    lengths,
  )
  assert.deepEqual(slices, [
    // Line 1 is "abc": reaching character 2 is reaching its last one, so it is
    // a block (that is what joins it to the line below).
    { line: 1, start: 1, end: 2, full: true },
    { line: 2, start: 0, end: 10, full: true },
    { line: 3, start: 0, end: 0, full: false },
  ])
})

test('selectionSlices: two runs on one line read as one slice', () => {
  const slices = selectionSlices(
    [
      { line: 2, start: 6, end: 9 },
      { line: 2, start: 1, end: 4 },
    ],
    lengths,
  )
  assert.deepEqual(slices, [{ line: 2, start: 1, end: 9, full: false }])
})

test('selectionSlices: a reversed run is normalised, an empty row is never full', () => {
  assert.deepEqual(selectionSlices([{ line: 1, start: 2, end: 0 }], lengths), [
    { line: 1, start: 0, end: 2, full: true },
  ])
  assert.deepEqual(selectionSlices([{ line: 3, start: 0, end: 0 }], lengths), [
    { line: 3, start: 0, end: 0, full: false },
  ])
})

test('selectionSlices: a line with no known length is never a block', () => {
  assert.deepEqual(selectionSlices([{ line: 9, start: 0, end: 4 }], lengths), [
    { line: 9, start: 0, end: 4, full: false },
  ])
})
