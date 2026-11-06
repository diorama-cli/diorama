/**
 * Positions are clamped before they reach the server (contract.md §3.12).
 *
 * Measured on tsserver 5.9.3: a column past the end of its line throws
 * `Debug Failure. False expression` inside `computePositionOfLineAndCharacter` and
 * **kills the server** — every later request on that mount fails. The page can
 * produce such a column honestly (a click right of a short line, a diff row
 * shorter than the line it came from), so the boundary is clamped here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampPosition } from '../src/server/lsp.ts'

const TEXT = 'const a = 1\nreturn a'

test('a position inside the text is unchanged', () => {
  assert.deepEqual(clampPosition(TEXT, { line: 1, character: 6 }), { line: 1, character: 6 })
  assert.deepEqual(clampPosition(TEXT, { line: 2, character: 3 }), { line: 2, character: 3 })
})

test('a column past the end of its line is clamped to the line length', () => {
  // "const a = 1" is 11 characters.
  assert.deepEqual(clampPosition(TEXT, { line: 1, character: 999 }), { line: 1, character: 11 })
})

test('a line past the end of the file is clamped to the last line', () => {
  assert.deepEqual(clampPosition(TEXT, { line: 99, character: 0 }), { line: 2, character: 0 })
})

test('a line below one is clamped to one', () => {
  assert.deepEqual(clampPosition(TEXT, { line: 0, character: 0 }), { line: 1, character: 0 })
  assert.deepEqual(clampPosition(TEXT, { line: -5, character: 2 }), { line: 1, character: 2 })
})

test('a negative column is clamped to zero', () => {
  assert.deepEqual(clampPosition(TEXT, { line: 1, character: -3 }), { line: 1, character: 0 })
})

test('an empty text clamps everything to line 1 column 0', () => {
  assert.deepEqual(clampPosition('', { line: 5, character: 5 }), { line: 1, character: 0 })
})

test('a trailing newline keeps its empty last line', () => {
  assert.deepEqual(clampPosition('a\n', { line: 2, character: 9 }), { line: 2, character: 0 })
})
