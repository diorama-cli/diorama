/**
 * The selection slices of a row-per-line reader (contract.md §3.11).
 *
 * Pure arithmetic only: which rows a DOM selection covers, and how much of
 * each. The painting itself lives in `selection.ts` (it needs a DOM); the rule
 * that "a row selected from its first character to its last is a full block" is
 * what makes a multi-line selection read as one block instead of a strip per
 * line — while a selection that starts in the middle of a row keeps its head.
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

test('selectionSlices: a row covered from its first character to its last is a block', () => {
  const slices = selectionSlices([{ line: 2, start: 0, end: 10 }], lengths)
  assert.deepEqual(slices, [{ line: 2, start: 0, end: 10, full: true }])
})

test('selectionSlices: a row covered in part is a run, not a block', () => {
  const slices = selectionSlices([{ line: 2, start: 3, end: 7 }], lengths)
  assert.deepEqual(slices, [{ line: 2, start: 3, end: 7, full: false }])
})

test('selectionSlices: reaching the last character is not enough — it must start at the first', () => {
  // The first row of a selection dragged from the middle of that row: every
  // character to the end is covered, but the row is not whole, so it stays a
  // run that starts where the reader began.
  const slices = selectionSlices([{ line: 2, start: 3, end: 10 }], lengths)
  assert.deepEqual(slices, [{ line: 2, start: 3, end: 10, full: false }])
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
    // Line 1 is "abc" and the run starts at character 1: it reaches the last
    // character but does not start at the first, so it is a run, not a block.
    { line: 1, start: 1, end: 2, full: false },
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
