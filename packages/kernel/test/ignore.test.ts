import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIgnore, DEFAULT_IGNORE } from '../src/shared/ignore.ts'

function hidden(patterns: readonly string[], path: string, kind: 'file' | 'dir' = 'file'): boolean {
  return createIgnore(patterns).matches(path, kind)
}

test('ignore: a bare name matches at any depth, files and directories', () => {
  assert.equal(hidden(['.git'], '.git', 'dir'), true)
  assert.equal(hidden(['.git'], 'a/b/.git', 'dir'), true)
  assert.equal(hidden(['node_modules'], 'x/node_modules', 'dir'), true)
  // `list` only lists one level: it never meets a path *below* a hidden
  // directory, so the matcher stays exact and does not special-case contents.
  assert.equal(hidden(['node_modules'], 'x/node_modules/y.js'), false)
  assert.equal(hidden(['node_modules'], 'my_node_modules.js'), false)
  // Name is matched per path segment, not as a suffix of a longer name.
  assert.equal(hidden(['git'], 'a/.git'), false)
})

test('ignore: a trailing slash restricts the match to directories', () => {
  assert.equal(hidden(['build/'], 'build', 'dir'), true)
  // The directory rule does not apply to a *file* at that path (a plain name
  // pattern would hide it; `dir/` shows it).
  assert.equal(hidden(['build/'], 'build', 'file'), false)
  assert.equal(hidden(['build'], 'build', 'file'), true)
  assert.equal(hidden(['build/'], 'src/build', 'dir'), true)
  assert.equal(hidden(['build/'], 'build2', 'dir'), false)
})

test('ignore: a pattern containing a slash is anchored to the mount root', () => {
  assert.equal(hidden(['docs/draft'], 'docs/draft'), true)
  assert.equal(hidden(['docs/draft'], 'src/docs/draft'), false)
  assert.equal(hidden(['/root.txt'], 'root.txt'), true)
  assert.equal(hidden(['/root.txt'], 'nested/root.txt'), false)
})

test('ignore: globs stay inside one segment; ** crosses segments', () => {
  assert.equal(hidden(['*.log'], 'a/b/x.log'), true)
  assert.equal(hidden(['*.log'], 'a/b/x.log.txt'), false)
  assert.equal(hidden(['a/*.log'], 'a/x.log'), true)
  assert.equal(hidden(['a/*.log'], 'a/b/x.log'), false)
  assert.equal(hidden(['**/fixtures'], 'a/b/fixtures', 'dir'), true)
  assert.equal(hidden(['**/fixtures'], 'fixtures', 'dir'), true)
  assert.equal(hidden(['a/**'], 'a/b/c'), true)
  assert.equal(hidden(['?.md'], 'a.md'), true)
  assert.equal(hidden(['?.md'], 'ab.md'), false)
  assert.equal(hidden(['[ab].md'], 'a.md'), true)
  assert.equal(hidden(['[!ab].md'], 'a.md'), false)
})

test('ignore: the defaults hide .git and node_modules only', () => {
  assert.equal(hidden(DEFAULT_IGNORE, '.git', 'dir'), true)
  assert.equal(hidden(DEFAULT_IGNORE, 'node_modules', 'dir'), true)
  assert.equal(hidden(DEFAULT_IGNORE, 'src', 'dir'), false)
  assert.equal(createIgnore([]).matches('.git', 'dir'), false)
  assert.equal(createIgnore([]).patterns.length, 0)
})

test('ignore: blank entries and comments are skipped', () => {
  const warnings: string[] = []
  const rules = createIgnore(['', '   ', '# comment', 'node_modules'], message => warnings.push(message))
  // The configured list is kept verbatim for diagnostics.
  assert.deepEqual(rules.patterns, ['', '   ', '# comment', 'node_modules'])
  assert.equal(rules.matches('node_modules', 'dir'), true)
  assert.equal(rules.matches('.git', 'dir'), false)
  assert.equal(warnings.length, 0)
  const empty = createIgnore([''], message => warnings.push(message))
  assert.equal(empty.matches('node_modules', 'dir'), false)
  assert.equal(warnings.length, 0)
})
