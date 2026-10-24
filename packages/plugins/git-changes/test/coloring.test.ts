import assert from 'node:assert/strict'
import { test } from 'node:test'
import { colorFileRows, colorSplitRows, type LineHighlighter } from '../src/coloring.ts'
import { buildFileRows, buildSplitRows } from '../src/model.ts'

/**
 * Colouring a reader's rows (contract.md §5.2): the two content readers draw
 * one row per element, so each row needs a fragment of its own.
 *
 * A fake engine stands in for highlight.js: it answers `<n:text>` per line, so
 * the tests are about **which text went where**, not about token colours.
 */
const fake: LineHighlighter = {
  lines(text: string): string[] {
    const lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.map((line, index) => `<${index + 1}:${line}>`)
  },
}

/** The file's own lines, as the engine would answer them (1-based → `<n:line>`). */
function fileHtml(text: string): string[] {
  return fake.lines(text)
}

test('colorFileRows: an unchanged row takes the file line with its own number', () => {
  const file = 'one\ntwo\nthree\n'
  const diff = '@@ -2,1 +2,1 @@\n-two\n+TWO\n'
  const rows = buildFileRows(file, diff)
  const html = colorFileRows(rows, fileHtml(file), fake, 'a.js')
  assert.equal(html.length, rows.length)
  // "one" is file line 1, "three" is file line 3.
  assert.equal(html[0], '<1:one>')
  assert.equal(html[3], '<3:three>')
})

test('colorFileRows: a deleted row is highlighted with its neighbours', () => {
  const file = 'one\nthree\n'
  const diff = '@@ -2,1 +1,1 @@\n-two\n+TWO\n'
  const rows = buildFileRows(file, diff)
  const html = colorFileRows(rows, fileHtml(file), fake, 'a.js')
  // The deleted row is not in the file: its text comes from the diff.
  const deleted = rows.findIndex(row => row.tone === 'del')
  assert.ok(deleted >= 0)
  assert.equal(html[deleted], '<1:two>')
})

test('colorFileRows: a run of deletions stays one text for the engine', () => {
  const file = 'head\ntail\n'
  const diff = '@@ -1,2 +1,1 @@\n-one\n-two\n+ONE\n'
  const rows = buildFileRows(file, diff)
  const seen: string[] = []
  const recording: LineHighlighter = {
    lines(text: string, path: string): string[] {
      seen.push(text)
      return fake.lines(text, path)
    },
  }
  colorFileRows(rows, fileHtml(file), recording, 'a.js')
  // The two deletions are one call, in order (a multi-line string among them
  // would otherwise be highlighted line by line).
  assert.ok(seen.includes('one\ntwo'))
})

test('colorSplitRows: both sides of an unchanged row share the file line', () => {
  const file = 'one\ntwo\n'
  const diff = '@@ -2,1 +2,1 @@\n-two\n+TWO\n'
  const rows = buildSplitRows(file, diff)
  const cells = colorSplitRows(rows, fileHtml(file), fake, 'a.js')
  assert.equal(cells.length, rows.length)
  const unchanged = rows.findIndex(row => row.change === 0)
  assert.ok(unchanged >= 0)
  assert.equal(cells[unchanged]?.old, '<1:one>')
  assert.equal(cells[unchanged]?.next, '<1:one>')
})

test('colorSplitRows: a deletion is on the left only, an insertion on the right only', () => {
  const file = 'one\nTWO\n'
  const diff = '@@ -2,1 +2,1 @@\n-two\n+TWO\n'
  const rows = buildSplitRows(file, diff)
  const cells = colorSplitRows(rows, fileHtml(file), fake, 'a.js')
  const changed = rows.findIndex(row => row.change !== 0)
  assert.ok(changed >= 0)
  assert.equal(cells[changed]?.old, '<1:two>')
  assert.equal(cells[changed]?.next, '<2:TWO>')
})

test('colorSplitRows: an insertion-only change has nothing on the left', () => {
  const file = 'one\ntwo\n'
  const diff = '@@ -1,0 +2,1 @@\n+two\n'
  const rows = buildSplitRows(file, diff)
  const cells = colorSplitRows(rows, fileHtml(file), fake, 'a.js')
  const changed = rows.findIndex(row => row.change !== 0)
  assert.ok(changed >= 0)
  assert.equal(cells[changed]?.old, undefined)
  assert.equal(cells[changed]?.next, '<2:two>')
})
