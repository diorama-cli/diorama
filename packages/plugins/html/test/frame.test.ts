import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSize, HTML_EXTENSIONS, lineCount } from '../src/frame.ts'

/**
 * The `html` renderer's pure helpers (contract.md §5.1). The sanitiser and the
 * frame's policy need a browser (DOMPurify, `srcdoc`): they are covered by
 * `apps/web/tests/m5-html.spec.ts`.
 */
test('html: the renderer claims .html and .htm, nothing else', () => {
  assert.deepEqual([...HTML_EXTENSIONS], ['html', 'htm'])
})

test('html: the header counts lines and sizes', () => {
  assert.equal(lineCount(''), 0)
  assert.equal(lineCount('a'), 1)
  assert.equal(lineCount('a\nb'), 2)
  // A trailing newline ends the last line; it does not open another.
  assert.equal(lineCount('a\nb\n'), 2)
  assert.equal(formatSize(12), '12 字节')
  assert.equal(formatSize(2048), '2.0 KiB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MiB')
})
