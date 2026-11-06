/**
 * The diff readers' row geometry (contract.md §3.12).
 *
 * The gestures find "line N of the file" through an attribute on the row and
 * a cell inside it. Three readers, three shapes — and the inline one puts a
 * `+` / `-` prefix in front of the file's text, which would shift every column by
 * one. These are the numbers that must not drift.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TEXT_ROWS } from 'diorama-ui/src/lsp-position.ts'
import { FILE_ROWS, INLINE_ROWS, SPLIT_ROWS } from '../src/diff-rows.ts'

test('the text renderers address rows by data-line-number, no trim', () => {
  assert.equal(TEXT_ROWS.lineAttribute, 'data-line-number')
  assert.equal(TEXT_ROWS.cellSelector, '.diorama-line__text')
  assert.equal(TEXT_ROWS.trim ?? 0, 0)
})

test('every diff reader addresses the current file, never the old one', () => {
  for (const rows of [INLINE_ROWS, FILE_ROWS, SPLIT_ROWS]) {
    assert.equal(rows.lineAttribute, 'data-new-line')
    assert.equal(rows.cellSelector, '.diorama-diff__code')
  }
})

test('only the inline reader has a prefix to drop', () => {
  assert.equal(INLINE_ROWS.trim, 1, 'the unified diff cell starts with +, - or a space')
  assert.equal(FILE_ROWS.trim ?? 0, 0, 'the whole-file reader draws the file text itself')
  assert.equal(SPLIT_ROWS.trim ?? 0, 0, 'the side-by-side reader draws the file text itself')
})
