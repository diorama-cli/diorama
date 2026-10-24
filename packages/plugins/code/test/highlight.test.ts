import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CODE_EXTENSIONS,
  escapeHtml,
  highlight,
  highlightLines,
  languageOf,
  splitHighlightedHtml,
  splitTextLines,
} from '../src/highlight.ts'

/**
 * The highlight engine (contract.md §5.2): one text → one HTML fragment **per
 * line**, each fragment complete on its own.
 *
 * The per-line shape is what the diff readers draw, so the tests pin the two
 * rules they rely on: a line count that matches the file's own numbering, and
 * spans that straddle a line break closed on both sides of it.
 */

test('languageOf: an extension the engine knows, and plaintext for the rest', () => {
  assert.equal(languageOf('src/app.ts'), 'typescript')
  assert.equal(languageOf('src/app.test.mjs'), 'javascript')
  assert.equal(languageOf('docs/notes.md'), 'plaintext')
  assert.equal(languageOf('LICENSE'), 'plaintext')
  // A dotfile has a name, not an extension.
  assert.equal(languageOf('.gitignore'), 'plaintext')
})

test('CODE_EXTENSIONS: the extensions the renderer claims', () => {
  assert.ok(CODE_EXTENSIONS.includes('ts'))
  assert.ok(CODE_EXTENSIONS.includes('py'))
  // Owned by other renderers (contract.md §5.1 rule 2).
  assert.ok(!CODE_EXTENSIONS.includes('md'))
  assert.ok(!CODE_EXTENSIONS.includes('html'))
  assert.ok(!CODE_EXTENSIONS.includes('svg'))
})

test('splitTextLines: a trailing newline does not add a line', () => {
  assert.deepEqual(splitTextLines(''), [])
  assert.deepEqual(splitTextLines('a\n'), ['a'])
  assert.deepEqual(splitTextLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(splitTextLines('a\n\nb'), ['a', '', 'b'])
})

test('highlightLines: one entry per line of the text', () => {
  const text = 'function hi() {\n  return "one"\n}\n'
  const lines = highlightLines(text, 'src/app.js')
  assert.equal(lines.length, 3)
  assert.ok(lines[0]?.includes('hljs-keyword'))
  assert.ok(lines[1]?.includes('hljs-string'))
})

test('highlightLines: a span across a line break is closed and reopened', () => {
  // A block comment is one token in highlight.js, over two lines.
  const text = '/* one\n   two */\nconst a = 1\n'
  const lines = highlightLines(text, 'src/app.js')
  assert.equal(lines.length, 3)
  // Each line carries a complete comment span of its own.
  assert.ok(lines[0]?.includes('<span class="hljs-comment">'))
  assert.ok(lines[0]?.trimEnd().endsWith('</span>'))
  assert.ok(lines[1]?.startsWith('<span class="hljs-comment">'))
  assert.ok(lines[1]?.trimEnd().endsWith('</span>'))
  // The line after the comment is not still inside it.
  assert.ok(!lines[2]?.includes('hljs-comment'))
})

test('highlightLines: plaintext is escaped, not interpreted', () => {
  const lines = highlightLines('<script>alert(1)</script>\n', 'notes.txt')
  assert.deepEqual(lines, ['&lt;script&gt;alert(1)&lt;/script&gt;'])
})

test('splitHighlightedHtml: a text with no newline is one fragment', () => {
  assert.deepEqual(splitHighlightedHtml('<b>one</b>'), ['<b>one</b>'])
  assert.deepEqual(splitHighlightedHtml(''), [''])
})

test('escapeHtml: the three characters that would be markup', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
})

test('highlight: an unknown language falls back to escaped text', () => {
  const result = highlight('const a = 1\n', 'notes.txt')
  assert.equal(result.language, 'plaintext')
  assert.equal(result.html, 'const a = 1\n')
})
