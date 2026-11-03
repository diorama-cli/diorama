import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countLines, displayPath, formatBytes, formatWhen, MAX_LINES_BYTES, splitRoot } from '../src/info.ts'

/**
 * What the status bar says (contract.md §5.4). The component is a thin
 * renderer over these; the rules a reader can check are here.
 */

test('formatBytes: the same three steps the renderers use', () => {
  assert.equal(formatBytes(0), '0 字节')
  assert.equal(formatBytes(999), '999 字节')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MiB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB')
})

test('formatBytes: a number the bar cannot mean is a dash, not NaN', () => {
  // A `stat` that failed, or a size from an older build: the cell says it has
  // nothing rather than printing `NaN MiB`.
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(Number.NaN), '—')
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), '—')
})

test('formatWhen: a real time is formatted, a broken one is dropped', () => {
  const text = formatWhen(Date.UTC(2026, 0, 2, 3, 4))
  assert.equal(typeof text, 'string')
  assert.ok((text ?? '').length > 0)
  // An unreadable number is `undefined`: the bar leaves the cell out instead
  // of printing `Invalid Date`.
  assert.equal(formatWhen(Number.NaN), undefined)
  assert.equal(formatWhen(Number.POSITIVE_INFINITY), undefined)
})

test('countLines: counted the way the readers count, not by splitting blindly', () => {
  // A trailing newline is the end of the last line, not an empty one after it.
  assert.equal(countLines('a\nb\n'), 2)
  assert.equal(countLines('a\nb'), 2)
  // An empty file has no lines; a file of one newline has one empty line.
  assert.equal(countLines(''), 0)
  assert.equal(countLines('\n'), 1)
  // Nothing was read: nothing is claimed.
  assert.equal(countLines(undefined), undefined)
})

test('MAX_LINES_BYTES: the count is a decoration, so it has a ceiling', () => {
  assert.equal(MAX_LINES_BYTES, 2 * 1024 * 1024)
  assert.ok(MAX_LINES_BYTES < 8 * 1024 * 1024, 'well under the text read limit')
})

test('displayPath: the mount root is spelled, never left blank', () => {
  assert.equal(displayPath(undefined), '.')
  assert.equal(displayPath(''), '.')
  assert.equal(displayPath('src/app.ts'), 'src/app.ts')
})

test('splitRoot: the whole served path, split so the last segment survives shrinking', () => {
  // The bar shows the full path (contract.md §5.4) — the name is what the eye
  // lands on, the parent is what an ellipsis is allowed to eat.
  assert.deepEqual(splitRoot('/Users/me/code/diorama'), { parent: '/Users/me/code/', name: 'diorama' })
  assert.deepEqual(splitRoot('/Users/me/code/diorama/'), { parent: '/Users/me/code/', name: 'diorama' })
  // A relative root, or a single segment: there is no parent to show.
  assert.deepEqual(splitRoot('diorama'), { parent: '', name: 'diorama' })
  // A filesystem root has nothing after the separator, so the separator is the
  // name: the cell still says something.
  assert.deepEqual(splitRoot('/'), { parent: '', name: '/' })
  // Windows, where the kernel reports the path it serves.
  assert.deepEqual(splitRoot('C:\\Users\\me\\diorama'), { parent: 'C:\\Users\\me\\', name: 'diorama' })
})
