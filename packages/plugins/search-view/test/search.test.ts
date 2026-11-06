import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FsService } from '../../../kernel/src/server/fs.ts'
import { defaultRgPath } from '../../../kernel/src/server/ripgrep.ts'
import { SearchService } from '../../../kernel/src/server/search.ts'
import type { SearchResult } from '../../../kernel/src/shared/search.ts'
import {
  clipLine,
  contentMatcher,
  fuzzyMatch,
  isSubsequence,
  SEARCH_MAX_PATHS,
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

/**
 * The same service with the ripgrep engine switched off: the JavaScript scanner
 * is the definition of "match" (contract.md §3.9), so the behaviours that
 * belong to it — the decoded-text cache, the binary NUL test — are tested
 * against it directly rather than against whatever the optional engine does.
 */
function plainService(root: string): SearchService {
  return new SearchService(new FsService(root), () => undefined)
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

test('search: a binary name is skipped before it is read', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // The NUL test would catch this one anyway; the name table is what keeps the
  // read from happening at all, so a *text* file named `.png` is the proof.
  writeFileSync(join(root, 'notes.png'), 'needle in a picture name\n')
  const search = service(root)
  const result = await search.search('needle', { kind: 'content' })
  assert.equal(result.files.some(file => file.path === 'notes.png'), false)
})

test('search: a cached file is re-read when it changes, not served stale', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const search = plainService(root)

  const first = await search.search('needle', { kind: 'content' })
  assert.deepEqual(first.files.map(file => file.path).sort(), ['README.md', 'src/app.ts'])
  assert.ok(search.cachedFiles > 0)

  // The second query is answered from the cache: same text, same numbers.
  const again = await search.search('needle', { kind: 'content' })
  assert.deepEqual(again.files.map(file => file.path).sort(), ['README.md', 'src/app.ts'])
  assert.equal(again.totalMatches, first.totalMatches)

  // A rewrite must not be served from the cache. A longer file is enough: the
  // size is part of the validation (mtime alone has one-second granularity on
  // some file systems).
  writeFileSync(join(root, 'src', 'other.ts'), 'now it has a needle in it\n')
  const third = await search.search('needle', { kind: 'content' })
  assert.deepEqual(third.files.map(file => file.path).sort(), ['README.md', 'src/app.ts', 'src/other.ts'])

  // A file that vanished stops being reported, even though it was cached.
  rmSync(join(root, 'src', 'other.ts'))
  const fourth = await search.search('needle', { kind: 'content' })
  assert.deepEqual(fourth.files.map(file => file.path).sort(), ['README.md', 'src/app.ts'])
})

test('search: a literal query reports the same lines as the regular expression', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const search = service(root)

  // The literal path is an optimisation, not a second definition of "match":
  // the same lines at the same columns as the engine reports.
  const literal = await search.search('needle', { kind: 'content' })
  const engine = await search.search('needle', { kind: 'content', wholeWord: true })
  for (const file of literal.files) {
    const other = engine.files.find(candidate => candidate.path === file.path)
    assert.ok(other !== undefined)
    assert.deepEqual(file.matches.map(match => [match.line, match.column]), other.matches.map(match => [match.line, match.column]))
  }

  // Overlapping-looking text is counted the way the regex counts it.
  writeFileSync(join(root, 'aaa.txt'), 'aaaa\n')
  const twice = await search.search('aa', { kind: 'content', caseSensitive: true })
  const aaa = twice.files.find(file => file.path === 'aaa.txt')
  assert.ok(aaa !== undefined)
  assert.equal(aaa.count, 2)
  assert.equal(aaa.matches[0]?.column, 1)
})

test('search: paths() lists every file, honouring ignore and the cap', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const search = service(root)

  const paths = await search.paths('')
  assert.deepEqual(paths.sort(), ['README.md', 'blob.bin', 'src/app.ts', 'src/other.ts'])
  // `node_modules` is hidden by the default ignore rules, exactly as in a search.
  assert.equal(paths.includes('node_modules/dep.js'), false)

  // A scope narrows the walk the same way a search's does.
  assert.deepEqual((await search.paths('src')).sort(), ['src/app.ts', 'src/other.ts'])
  await assert.rejects(search.paths('missing'), /ENOENT/)
  assert.ok(SEARCH_MAX_PATHS >= 20_000)
})
test('search: the ripgrep engine answers exactly what the JavaScript scanner does', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A file with multi-byte text before the hit: ripgrep reports byte offsets
  // and the contract wants characters, so this is where a naive port breaks.
  writeFileSync(join(root, 'unicode.txt'), '中文注释 needle 后面还有中文\nplain needle here\n')
  writeFileSync(join(root, 'many.txt'), 'needle needle needle\nneedle again\n')

  const binary = defaultRgPath()
  if (binary === undefined) {
    t.skip('no ripgrep binary in this install')
    return
  }
  const accelerated = new SearchService(new FsService(root), () => binary)
  const plain = new SearchService(new FsService(root), () => undefined)
  const shape = (result: SearchResult): string =>
    JSON.stringify(result.files.map(file => [file.path, file.count, file.matches.map(match => [match.line, match.column, match.length, match.text])]))

  const queries = ['needle', 'NEEDLE', '中文', 'needle here', 'nothing-at-all', 'needle\s+here', 'n[e]+dle', 'TODO|FIXME']
  for (const query of queries) {
    for (const options of [{}, { caseSensitive: true }, { wholeWord: true }, { maxFiles: 1 }, { maxMatchesPerFile: 1 }, { regex: true }]) {
      const a = await accelerated.search(query, { kind: 'content', ...options })
      const b = await plain.search(query, { kind: 'content', ...options })
      assert.equal(shape(a), shape(b), query + ' ' + JSON.stringify(options))
      assert.equal(a.totalFiles, b.totalFiles)
      assert.equal(a.totalMatches, b.totalMatches)
      assert.equal(a.truncated, b.truncated)
    }
  }
  // The multi-byte line proves the column is in characters, not bytes:
  // "中文注释 " is 5 characters, so `needle` starts at column 6.
  const result = await accelerated.search('needle', { kind: 'content' })
  const unicode = result.files.find(file => file.path === 'unicode.txt')
  assert.ok(unicode !== undefined)
  assert.equal(unicode.matches[0]?.column, 6)
})

test('search: without the engine the JavaScript scanner answers the same', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A path that is not a runnable binary: the service must fall back, not fail.
  const broken = new SearchService(new FsService(root), () => '/nonexistent/rg')
  const result = await broken.search('needle', { kind: 'content' })
  assert.deepEqual(result.files.map(file => file.path).sort(), ['README.md', 'src/app.ts'])
  assert.equal(result.totalMatches, 5)
})

