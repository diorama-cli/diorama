import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contentDisposition,
  decodeRawPath,
  encodeRawPath,
  rawContentType,
  rawUrl,
} from '../src/shared/raw.ts'
import { RAW_PREFIX } from '../src/shared/types.ts'

/**
 * The mount's raw-bytes URL (contract.md §4): `<origin>/~raw~/<RelPath>`.
 *
 * Three reader actions share it (download, copy the link, open a window), so
 * the encoding, the URL and the one non-ASCII-safe header are pinned here.
 */

test('the prefix cannot be confused with the page route', () => {
  assert.equal(RAW_PREFIX, '/~raw~/')
  // `/~/x` is the page, `/~raw~/x` is the file: neither is a prefix of the other.
  assert.equal(RAW_PREFIX.startsWith('/~/'), false)
  assert.equal('/~/x'.startsWith(RAW_PREFIX), false)
})

test('encodeRawPath keeps the separators and escapes each segment', () => {
  assert.equal(encodeRawPath('src/app.js'), 'src/app.js')
  assert.equal(encodeRawPath('a b/c#d.txt'), 'a%20b/c%23d.txt')
  assert.equal(encodeRawPath('文档/说明.md'), '%E6%96%87%E6%A1%A3/%E8%AF%B4%E6%98%8E.md')
  // A `?` or `+` in a name is data, not a query or a space.
  assert.equal(encodeRawPath('what?.md'), 'what%3F.md')
  assert.equal(encodeRawPath('a+b.md'), 'a%2Bb.md')
  // No leading or trailing slash, whatever the caller passes.
  assert.equal(encodeRawPath('/src/app.js/'), 'src/app.js')
})

test('decodeRawPath answers the path, or says it is not a raw URL', () => {
  assert.equal(decodeRawPath('/~raw~/src/app.js'), 'src/app.js')
  assert.equal(decodeRawPath('/~raw~/a%20b/c%23d.txt'), 'a b/c#d.txt')
  // Not this route at all.
  assert.equal(decodeRawPath('/~/src/app.js'), undefined)
  assert.equal(decodeRawPath('/plugin.json'), undefined)
  // This route, but unusable: the caller answers 400 rather than guessing.
  assert.equal(decodeRawPath('/~raw~/'), false)
  assert.equal(decodeRawPath('/~raw~/%E0%A4%A'), false)
})

test('rawUrl builds the link a reader copies', () => {
  assert.equal(rawUrl('http://127.0.0.1:1234', 'src/app.js'), 'http://127.0.0.1:1234/~raw~/src/app.js')
  // A trailing slash is how the CLI prints the mount URL: both spellings agree.
  assert.equal(rawUrl('http://127.0.0.1:1234/', 'a b.md'), 'http://127.0.0.1:1234/~raw~/a%20b.md')
  // `?download=1` is the only difference between "show it" and "save it".
  assert.equal(rawUrl('http://h:1', 'x.png', { download: true }), 'http://h:1/~raw~/x.png?download=1')
  assert.equal(rawUrl('http://h:1', 'x.png', { download: false }), 'http://h:1/~raw~/x.png')
})

test('rawContentType is the kernel table, with a charset on the textual ones', () => {
  // Binary types carry no parameter: a browser shows or plays them.
  assert.equal(rawContentType('a.png'), 'image/png')
  assert.equal(rawContentType('a.pdf'), 'application/pdf')
  assert.equal(rawContentType('a.svg'), 'image/svg+xml')
  assert.equal(rawContentType('a.mp4'), 'video/mp4')
  // Text carries one: without it the browser guesses the encoding and a UTF-8
  // file comes out as mojibake (the reason this route says charset at all).
  assert.equal(rawContentType('a.md'), 'text/markdown; charset=utf-8')
  assert.equal(rawContentType('a.html'), 'text/html; charset=utf-8')
  assert.equal(rawContentType('a.py'), 'text/x-python; charset=utf-8')
  assert.equal(rawContentType('a.json'), 'application/json; charset=utf-8')
  // A type the table does not know is an opaque download, not a guess.
  assert.equal(rawContentType('a.unknown'), 'application/octet-stream')
})

test('contentDisposition survives a non-ASCII name', () => {
  assert.equal(
    contentDisposition('report.pdf'),
    'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf',
  )
  const chinese = contentDisposition('说明 文档.md')
  assert.ok(chinese.startsWith('attachment; filename="'))
  // The fallback is ASCII and still a file name; the real one rides in filename*.
  assert.ok(chinese.includes('filename*=UTF-8\'\'%E8%AF%B4%E6%98%8E%20%E6%96%87%E6%A1%A3.md'))
  assert.match(chinese, /filename="[_ ]+\.md"/)
})

test('contentDisposition cannot be turned into a second header', () => {
  // A name is input from the disk: a newline or a quote must not end the header.
  const evil = contentDisposition('a"b\r\nSet-Cookie: x=1')
  assert.equal(evil.includes('\n'), false)
  assert.equal(evil.includes('\r'), false)
  assert.ok(evil.startsWith('attachment; filename="a_bSet-Cookie: x=1"'))
})
