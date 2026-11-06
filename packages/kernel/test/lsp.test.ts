/**
 * The LSP vocabulary and the answer parsing (contract.md §3.12).
 *
 * These are the rules that cannot be checked by eye once they are wrong: a
 * 0-based line that leaks into a 1-based gutter highlights the line above, and
 * a \`LocationLink\` that is read as a \`Location\` silently answers "nothing".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromLsp, fromLspRange, languageOfPath, LSP_LANGUAGES, toLsp } from '../src/shared/lsp.ts'
import { cacheDirFor, hoverText, locationsOf, LSP_CACHE_ROOT, symbolsOf } from '../src/server/lsp.ts'

test('toLsp turns a 1-based line into the protocol 0-based one', () => {
  assert.deepEqual(toLsp({ line: 1, character: 0 }), { line: 0, character: 0 })
  assert.deepEqual(toLsp({ line: 42, character: 7 }), { line: 41, character: 7 })
})

test('fromLsp is the exact inverse of toLsp', () => {
  for (const line of [1, 2, 17, 999]) {
    for (const character of [0, 3, 40]) {
      assert.deepEqual(fromLsp(toLsp({ line, character })), { line, character })
    }
  }
})

test('toLsp never sends NaN or a negative to the server', () => {
  assert.deepEqual(toLsp({ line: 0, character: -5 }), { line: 0, character: 0 })
  assert.deepEqual(toLsp({ line: Number.NaN, character: Number.NaN }), { line: 0, character: 0 })
})

test('fromLspRange shifts both ends', () => {
  assert.deepEqual(
    fromLspRange({ start: { line: 0, character: 4 }, end: { line: 2, character: 9 } }),
    { start: { line: 1, character: 4 }, end: { line: 3, character: 9 } },
  )
})

test('languageOfPath claims the extensions a server in this build serves', () => {
  assert.equal(languageOfPath('src/app.ts'), 'typescript')
  assert.equal(languageOfPath('src/App.tsx'), 'typescript')
  assert.equal(languageOfPath('a/b.c'), 'c')
  assert.equal(languageOfPath('a/b.h'), 'c')
  assert.equal(languageOfPath('a/b.cpp'), 'cpp')
  assert.equal(languageOfPath('main.go'), 'go')
  assert.equal(languageOfPath('README.md'), undefined)
  assert.equal(languageOfPath('no-extension'), undefined)
  assert.equal(languageOfPath('trailing.'), undefined)
})

test('every claimed extension belongs to exactly one language', () => {
  const seen = new Map()
  for (const [language, extensions] of Object.entries(LSP_LANGUAGES)) {
    for (const extension of extensions) {
      assert.equal(seen.get(extension), undefined, extension + ' is claimed twice')
      seen.set(extension, language)
    }
  }
})

test('cacheDirFor flattens a project path and never leaves the cache root', () => {
  assert.equal(cacheDirFor('/Users/me/project'), LSP_CACHE_ROOT + '/Users-me-project')
  assert.equal(cacheDirFor('/a/b/'), LSP_CACHE_ROOT + '/a-b')
  assert.equal(cacheDirFor('/a-b'), LSP_CACHE_ROOT + '/a--b')
  assert.equal(cacheDirFor('/'), LSP_CACHE_ROOT + '/root')
  assert.ok(cacheDirFor('/x/y').startsWith(LSP_CACHE_ROOT + '/'))
})

test('cacheDirFor keeps a slash and a dash apart', () => {
  // Flattening must not make two projects share one cache: the character the
  // path separator becomes cannot be one a path may contain, so it is escaped.
  assert.notEqual(cacheDirFor('/a/b'), cacheDirFor('/a-b'))
})

test('locationsOf reads a Location list', () => {
  const pathOf = (uri: string): string | undefined => (uri === 'file:///root/src/a.ts' ? 'src/a.ts' : undefined)
  const locations = locationsOf(
    [{ uri: 'file:///root/src/a.ts', range: { start: { line: 9, character: 2 }, end: { line: 9, character: 6 } } }],
    pathOf,
  )
  assert.deepEqual(locations, [{ path: 'src/a.ts', range: { start: { line: 10, character: 2 }, end: { line: 10, character: 6 } } }])
})

test('locationsOf prefers a LocationLink target selection', () => {
  const pathOf = (uri: string): string | undefined => (uri === 'file:///root/b.ts' ? 'b.ts' : undefined)
  const locations = locationsOf(
    [
      {
        targetUri: 'file:///root/b.ts',
        targetRange: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
        targetSelectionRange: { start: { line: 3, character: 7 }, end: { line: 3, character: 12 } },
      },
    ],
    pathOf,
  )
  assert.equal(locations.length, 1)
  assert.deepEqual(locations[0]?.range.start, { line: 4, character: 7 })
})

test('locationsOf drops places the page cannot open', () => {
  const pathOf = (uri: string): string | undefined => (uri === 'file:///root/a.ts' ? 'a.ts' : undefined)
  const locations = locationsOf(
    [
      { uri: 'file:///elsewhere/node_modules/x/index.d.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      { uri: 'file:///root/a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
    ],
    pathOf,
  )
  assert.deepEqual(locations.map(location => location.path), ['a.ts'])
})

test('locationsOf answers an empty list for null, undefined and garbage', () => {
  assert.deepEqual(locationsOf(null, () => undefined), [])
  assert.deepEqual(locationsOf(undefined, () => undefined), [])
  assert.deepEqual(locationsOf([null, 3, {}], () => undefined), [])
})

test('hoverText reads all three protocol shapes', () => {
  assert.equal(hoverText('plain'), 'plain')
  assert.equal(hoverText({ kind: 'markdown', value: '**bold**' }), '**bold**')
  assert.equal(hoverText([{ value: 'a' }, { value: 'b' }]), 'a\n\nb')
  assert.equal(hoverText(null), '')
})

test('symbolsOf reads DocumentSymbol and SymbolInformation alike', () => {
  const hierarchical = symbolsOf([
    {
      name: 'outer',
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
      selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
      children: [
        {
          name: 'inner',
          kind: 13,
          range: { start: { line: 2, character: 2 }, end: { line: 2, character: 9 } },
          selectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 9 } },
        },
      ],
    },
  ])
  assert.equal(hierarchical.length, 1)
  assert.equal(hierarchical[0]?.name, 'outer')
  assert.deepEqual(hierarchical[0]?.selectionRange.start, { line: 1, character: 9 })
  assert.equal(hierarchical[0]?.children?.[0]?.name, 'inner')

  const flat = symbolsOf([
    { name: 'add', kind: 12, location: { uri: 'file:///x.c', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 9 } } } },
  ])
  assert.equal(flat.length, 1)
  assert.deepEqual(flat[0]?.range.start, { line: 3, character: 0 })
  // A SymbolInformation has no selection range: the whole range is the answer.
  assert.deepEqual(flat[0]?.selectionRange, flat[0]?.range)
})

test('symbolsOf drops entries without a range', () => {
  assert.deepEqual(symbolsOf([{ name: 'x', kind: 12 }]), [])
  assert.deepEqual(symbolsOf('nonsense'), [])
})
