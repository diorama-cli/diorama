import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyLink, headingSlug, resolveLinkPath, uniqueHeadingId } from '../src/links.ts'

/**
 * Where a link in a rendered Markdown file points (docs/m12/spec.md).
 *
 * The classification is the whole decision: the browser must not be allowed to
 * follow a relative `href`, because a page navigation drops every open tab.
 */

test('links: a relative path resolves against the file that contains it', () => {
  assert.equal(resolveLinkPath('docs/notes.md', 'other.md'), 'docs/other.md')
  assert.equal(resolveLinkPath('docs/notes.md', '../README.md'), 'README.md')
  assert.equal(resolveLinkPath('docs/notes.md', 'a/b/c.md'), 'docs/a/b/c.md')
  // A leading `/` is the mount root, not the filesystem root.
  assert.equal(resolveLinkPath('docs/notes.md', '/src/app.js'), 'src/app.js')
  // A top-level file's relative link has no directory to resolve against.
  assert.equal(resolveLinkPath('README.md', 'docs/notes.md'), 'docs/notes.md')
})

test('links: a path that leaves the mount is refused, not clamped', () => {
  assert.equal(resolveLinkPath('README.md', '../etc/passwd'), undefined)
  assert.equal(resolveLinkPath('docs/notes.md', '../../secrets'), undefined)
  assert.equal(resolveLinkPath('README.md', '/..'), undefined)
  // Normalisation happens before the check: a `..` that pops the mount root
  // is refused even when the rest of the path would come back down.
  assert.equal(resolveLinkPath('docs/notes.md', '../../x'), undefined)
  // A `..` that only pops back to the root is fine (this stays inside).
  assert.equal(resolveLinkPath('docs/notes.md', '../x'), 'x')
  assert.equal(resolveLinkPath('docs/notes.md', 'docs/../x'), 'docs/x')
})

test('links: a file, an anchor, another origin and a refusal are four answers', () => {
  const file = 'docs/notes.md'
  assert.deepEqual(classifyLink('other.md', file), { kind: 'file', path: 'docs/other.md' })
  assert.deepEqual(classifyLink('other.md#part', file), { kind: 'file', path: 'docs/other.md', anchor: 'part' })
  assert.deepEqual(classifyLink('#intro', file), { kind: 'anchor', id: 'intro' })
  assert.deepEqual(classifyLink('https://example.com/x', file), { kind: 'external' })
  assert.deepEqual(classifyLink('mailto:someone@example.com', file), { kind: 'external' })
  assert.deepEqual(classifyLink('//example.com/x', file), { kind: 'external' })
  assert.deepEqual(classifyLink('../../etc/passwd', file), { kind: 'invalid' })
  assert.deepEqual(classifyLink('', file), { kind: 'invalid' })
  assert.deepEqual(classifyLink('   ', file), { kind: 'invalid' })
  assert.deepEqual(classifyLink('#', file), { kind: 'invalid' })
})

test('links: escapes are decoded once, and a malformed one is refused', () => {
  // A space in a file name arrives percent-encoded.
  assert.deepEqual(classifyLink('my%20file.md', 'README.md'), { kind: 'file', path: 'my file.md' })
  // A literal `%20` in a name is written `%2520`; decoding must not double up.
  assert.deepEqual(classifyLink('%2520.md', 'README.md'), { kind: 'file', path: '%20.md' })
  // Decoding happens *before* the traversal check, so an encoded `..` is caught.
  assert.deepEqual(classifyLink('%2e%2e/%2e%2e/etc/passwd', 'README.md'), { kind: 'invalid' })
  assert.deepEqual(classifyLink('%E0%A4%A.md', 'README.md'), { kind: 'invalid' })
  // A query string is dropped: a mounted file is read by path.
  assert.deepEqual(classifyLink('notes.md?plain=1', 'README.md'), { kind: 'file', path: 'notes.md' })
  // `#` with nothing after it still names the file.
  assert.deepEqual(classifyLink('notes.md#', 'README.md'), { kind: 'file', path: 'notes.md' })
})

test('links: a fragment is decoded too', () => {
  assert.deepEqual(classifyLink('#getting%20started', 'README.md'), { kind: 'anchor', id: 'getting started' })
  assert.deepEqual(classifyLink('docs/a.md#b%2Fc', 'README.md'), { kind: 'file', path: 'docs/a.md', anchor: 'b/c' })
})

test('headings: the slug follows the GitHub convention', () => {
  assert.equal(headingSlug('Getting Started'), 'getting-started')
  assert.equal(headingSlug('  Hello, World!  '), 'hello-world')
  assert.equal(headingSlug('C++ / Rust'), 'c-rust')
  assert.equal(headingSlug('snake_case and kebab-case'), 'snake_case-and-kebab-case')
  // Inline markup is stripped before slugging.
  assert.equal(headingSlug('Hello <em>World</em>'), 'hello-world')
  // CJK has no case and no separators: it survives as written.
  assert.equal(headingSlug('主题切换'), '主题切换')
  // An empty heading still needs an id.
  assert.equal(headingSlug('!!!'), '')
})

test('headings: repeated headings get distinct ids', () => {
  const seen = new Map<string, number>()
  assert.equal(uniqueHeadingId('intro', seen), 'intro')
  assert.equal(uniqueHeadingId('intro', seen), 'intro-1')
  assert.equal(uniqueHeadingId('intro', seen), 'intro-2')
  // An empty slug falls back to a stable name instead of an empty id.
  assert.equal(uniqueHeadingId('', seen), 'section')
  assert.equal(uniqueHeadingId('', seen), 'section-1')
})
