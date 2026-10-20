import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FsService } from '../../../kernel/src/server/fs.ts'
import { SearchService } from '../../../kernel/src/server/search.ts'
import {
  clipLine,
  contentMatcher,
  fuzzyMatch,
  isSubsequence,
  SEARCH_MAX_QUERY_CHARS,
} from '../../../kernel/src/shared/search.ts'

/** A small tree: two text files, one nested, one binary, one hidden directory. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'diorama-search-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'README.md'), '# Readme\n\nneedle here\nand NEEDLE again\n')
  writeFileSync(join(root, 'src', 'app.ts'), 'const needle = 1\n// needle twice needle\n')
  writeFileSync(join(root, 'src', 'other.ts'), 'nothing to see\n')
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'needle in a hidden place\n')
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 110, 101, 101, 100, 108, 101]))
  return root
}

function service(root: string): SearchService {
  return new SearchService(new FsService(root))
}

test('search: name search finds paths by subsequence, hidden entries excluded', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const search = service(root)

  const result = await search.search('appts', { kind: 'name' })
  assert.equal(result.kind, 'name')
  assert.deepEqual(result.files.map(file => file.path), ['src/app.ts'])
  assert.equal(result.totalFiles, 1)

  // The basename ranks above a directory match; every file is still a hit.
  const ts = await search.search('ts', { kind: 'name' })
  assert.deepEqual(ts.files.map(file => file.path).sort(), ['src/app.ts', 'src/other.ts'])

  // `node_modules` is hidden by the default ignore rules (contract.md §3.1).
  const hidden = await search.search('dep', { kind: 'name' })
  assert.deepEqual(hidden.files, [])
})

test('search: content search reports file, line, column and the line text', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const search = service(root)

  const result = await search.search('needle', { kind: 'content' })
  assert.equal(result.kind, 'content')
  const byPath = new Map(result.files.map(file => [file.path, file]))
  // Case-insensitive by default: both lines of README.md, two hits on one line.
  const readme = byPath.get('README.md')
  assert.ok(readme !== undefined)
  assert.equal(readme.count, 2)
  assert.deepEqual(readme.matches.map(match => match.line), [3, 4])
  assert.equal(readme.matches[0]?.column, 1)
  assert.equal(readme.matches[0]?.text, 'needle here')
  assert.equal(readme.matches[0]?.path, 'README.md')

  const app = byPath.get('src/app.ts')
  assert.ok(app !== undefined)
  // Line 2 holds two hits: the row is one per line, `count` is per hit.
  assert.equal(app.count, 3)
  assert.deepEqual(app.matches.map(match => match.line), [1, 2])
  assert.equal(result.totalFiles, 2)
  assert.equal(result.totalMatches, 5)

  // A binary file is skipped, not decoded into mojibake.
  assert.equal(byPath.has('blob.bin'), false)
})

test('search: case sensitivity, whole word and regular expressions', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const search = service(root)

  const sensitive = await search.search('NEEDLE', { kind: 'content', caseSensitive: true })
  assert.deepEqual(sensitive.files.map(file => file.path), ['README.md'])
  assert.equal(sensitive.totalMatches, 1)

  // `needle` in `needles` is not a whole word.
  writeFileSync(join(root, 'words.txt'), 'needles\nneedle\n')
  const whole = await search.search('needle', { kind: 'content', wholeWord: true })
  const words = whole.files.find(file => file.path === 'words.txt')
  assert.ok(words !== undefined)
  assert.equal(words.count, 1)
  assert.equal(words.matches[0]?.line, 2)

  const regex = await search.search('needle\\s+here', { kind: 'content', regex: true })
  assert.deepEqual(regex.files.map(file => file.path), ['README.md'])
})

test('search: an invalid regular expression is EINVAL, an empty query is nothing', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const search = service(root)

  await assert.rejects(search.search('([', { kind: 'content', regex: true }), /EINVAL/)
  const empty = await search.search('')
  assert.deepEqual(empty.files, [])
  assert.equal(empty.totalFiles, 0)
  await assert.rejects(search.search('x'.repeat(SEARCH_MAX_QUERY_CHARS + 1)), /EINVAL/)
  // A scope that does not exist fails like `fs.list` does.
  await assert.rejects(search.search('needle', { kind: 'content', scope: 'missing' }), /ENOENT/)
})

test('search: scope narrows the walk, and limits truncate instead of failing', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const search = service(root)

  const scoped = await search.search('needle', { kind: 'content', scope: 'src' })
  assert.deepEqual(scoped.files.map(file => file.path), ['src/app.ts'])

  const limited = await search.search('needle', { kind: 'content', maxFiles: 1, maxMatchesPerFile: 1 })
  assert.equal(limited.files.length, 1)
  assert.equal(limited.truncated, true)
  // The real totals are still reported, even though only one file came back.
  assert.equal(limited.totalFiles, 2)
  assert.equal(limited.totalMatches, 5)
})

test('search: fuzzyMatch prefers consecutive runs and basename matches', () => {
  assert.ok(isSubsequence('src/app.ts', 'appts'))
  assert.equal(isSubsequence('src/app.ts', 'zzz'), false)
  const strong = fuzzyMatch('app.ts', 'app')
  const weak = fuzzyMatch('a/x/p/p.ts', 'app')
  assert.ok(strong !== undefined && weak !== undefined)
  assert.ok(strong.score > weak.score)
  assert.deepEqual(strong.positions, [0, 1, 2])
  assert.equal(fuzzyMatch('app.ts', 'xyz'), undefined)
  // Case does not matter for matching.
  assert.notEqual(fuzzyMatch('README.md', 'readme'), undefined)
})

test('search: contentMatcher escapes literals and clipLine keeps the hit visible', () => {
  const literal = contentMatcher({ query: 'a.b' })
  assert.ok(literal !== undefined)
  assert.equal(literal.test('a.b').length, 1)
  assert.equal(literal.test('axb').length, 0)
  const empty = contentMatcher({ query: 'x*', regex: true })
  assert.ok(empty !== undefined)
  // An empty match must not loop forever.
  assert.ok(empty.test('abc').length > 0)

  const long = 'x'.repeat(400) + 'needle' + 'y'.repeat(400)
  const clipped = clipLine(long, 401, 6)
  assert.ok(clipped.includes('needle'))
  assert.ok(clipped.length < long.length)
  assert.ok(clipped.startsWith('…'))
  assert.ok(clipped.endsWith('…'))
  // A short line is returned as it is.
  assert.equal(clipLine('needle here', 1, 6), 'needle here')
})
