import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
// @ts-expect-error -- a plain .mjs build script, outside the CLI's `src` project
import { baseUrls, rewriteReadme, unresolvedLinks } from '../../../scripts/readme-for-npm.mjs'

/**
 * The README npm shows is rendered on npmjs.com, where a relative `docs/x.md`
 * or `docs/m7/tree.png` does not exist (docs/m8/spec.md §3). The assembler
 * publishes a rewritten copy; these tests pin the rewrite rules.
 */

const REPO = { repositoryUrl: 'git+https://github.com/diorama-cli/diorama.git', branch: 'main' }

test('base urls: blob for links, raw for images', () => {
  assert.deepEqual(baseUrls(REPO), {
    blob: 'https://github.com/diorama-cli/diorama/blob/main/',
    raw: 'https://raw.githubusercontent.com/diorama-cli/diorama/main/',
  })
})

test('base urls: accepts a plain https url and strips the trailing .git', () => {
  assert.equal(
    baseUrls({ repositoryUrl: 'https://github.com/o/r.git/', branch: 'v1' }).blob,
    'https://github.com/o/r/blob/v1/',
  )
})

test('base urls: a non-github host is an error, not a silent wrong link', () => {
  assert.throws(() => baseUrls({ repositoryUrl: 'git+https://gitlab.com/o/r.git' }), /only github.com/)
  assert.throws(() => baseUrls({ repositoryUrl: 'https://github.com/owner' }), /not a repository URL/)
})

test('relative links and images become absolute; the label and title survive', () => {
  const out = rewriteReadme(
    ['See [the contract](docs/contract.md).', '![tree](docs/m7/tree.png)', '[top](#diorama)'].join('\n'),
    REPO,
  )
  assert.equal(
    out,
    [
      'See [the contract](https://github.com/diorama-cli/diorama/blob/main/docs/contract.md).',
      '![tree](https://raw.githubusercontent.com/diorama-cli/diorama/main/docs/m7/tree.png)',
      '[top](#diorama)',
    ].join('\n'),
  )
})

test('absolute urls, fragments and a leading slash are left alone', () => {
  const source = [
    '[npm](https://npmjs.com/x)',
    '[mail](mailto:a@b.c)',
    '[frag](#section)',
    '[root](/absolute/path.md)',
    '[proto](//cdn.example/x.png)',
  ].join('\n')
  assert.equal(rewriteReadme(source, REPO), source)
})

test('a link inside a fenced block is content, not a link', () => {
  const source = ['```bash', 'cat docs/contract.md', '[x](docs/contract.md)', '```', '[real](docs/x.md)'].join('\n')
  const out = rewriteReadme(source, REPO)
  assert.match(out, /^cat docs\/contract\.md$/m)
  assert.match(out, /^\[x\]\(docs\/contract\.md\)$/m)
  assert.match(out, /\[real\]\(https:\/\/github\.com\/diorama-cli\/diorama\/blob\/main\/docs\/x\.md\)/)
})

test('an unresolved relative link is reported', () => {
  assert.deepEqual(unresolvedLinks('[a](docs/x.md) [b](https://x.y) ![c](p.png)'), ['docs/x.md', 'p.png'])
})

test('a relative src/href in raw html is reported, not silently shipped', () => {
  // The rewrite only knows Markdown syntax; an HTML link has to fail loudly.
  assert.deepEqual(unresolvedLinks('<img src="docs/x.png"> <a href="docs/y.md">y</a>'), [
    'docs/x.png',
    'docs/y.md',
  ])
  assert.deepEqual(unresolvedLinks('<img src="https://x/y.png"> <a href="#top">t</a>'), [])
})

test('the repository README has no relative link left after the rewrite', () => {
  const source = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
  assert.deepEqual(unresolvedLinks(rewriteReadme(source, REPO)), [])
})
