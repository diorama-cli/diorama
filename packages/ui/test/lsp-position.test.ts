/**
 * The navigation gestures' position rules (contract.md §3.12).
 *
 * A column that is off by one asks the server about the wrong symbol and the
 * jump lands somewhere plausible but wrong — worse than no jump at all. So the
 * one rule that decides it (which identifier a caret is in) is pinned here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isWordChar, wordAt } from '../src/lsp-position.ts'

const SOURCE = 'const total = compute(alpha, beta)\nreturn total'

test('isWordChar accepts identifiers and nothing else', () => {
  assert.equal(isWordChar('a'), true)
  assert.equal(isWordChar('Z'), true)
  assert.equal(isWordChar('0'), true)
  assert.equal(isWordChar('_'), true)
  assert.equal(isWordChar('$'), true)
  assert.equal(isWordChar(' '), false)
  assert.equal(isWordChar('('), false)
  assert.equal(isWordChar('.'), false)
  assert.equal(isWordChar(undefined), false)
})

test('wordAt walks back to the start of the identifier', () => {
  // "compute" starts at column 14.
  assert.deepEqual(wordAt(SOURCE, { line: 1, character: 18 }), { line: 1, character: 14 })
  assert.deepEqual(wordAt(SOURCE, { line: 1, character: 14 }), { line: 1, character: 14 })
  // "alpha" starts at column 22.
  assert.deepEqual(wordAt(SOURCE, { line: 1, character: 26 }), { line: 1, character: 22 })
})

test('wordAt answers undefined on whitespace and punctuation', () => {
  assert.equal(wordAt(SOURCE, { line: 1, character: 5 }), undefined, 'the space after "const"')
  assert.equal(wordAt(SOURCE, { line: 1, character: 21 }), undefined, 'the "(" before "alpha"')
  assert.equal(wordAt(SOURCE, { line: 1, character: 27 }), undefined, 'the "," after "alpha"')
})

test('wordAt on the second line is 1-based like the gutter', () => {
  assert.deepEqual(wordAt(SOURCE, { line: 2, character: 8 }), { line: 2, character: 7 })
})

test('wordAt answers undefined past the end of the file', () => {
  assert.equal(wordAt(SOURCE, { line: 9, character: 0 }), undefined)
  assert.equal(wordAt('', { line: 1, character: 0 }), undefined)
})

test('wordAt does not cross into the previous line', () => {
  const source = 'alpha\nbeta'
  // Column 0 of line 2 is the start of "beta", not the end of "alpha".
  assert.deepEqual(wordAt(source, { line: 2, character: 0 }), { line: 2, character: 0 })
})
