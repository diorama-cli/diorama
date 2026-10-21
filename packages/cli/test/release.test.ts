import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
// @ts-expect-error -- plain .mjs release scripts, outside the CLI's `src` project
import { changelogEntry, insertChangelog, PREAMBLE } from '../../../scripts/release/changelog.mjs'
// @ts-expect-error -- same
import {
  contractRange,
  currentVersion,
  nextVersion,
  parseVersion,
  releaseEdits,
  verifyTarball,
} from '../../../scripts/release/plan.mjs'
// @ts-expect-error -- same
import { versionProblems } from '../../../scripts/release/verify.mjs'

/**
 * A release moves one number to *many* places (docs/release.md). Every one of
 * them fails silently when missed: the tarball still builds and the mistake
 * only shows up as "plugin refused to load" or a stale number on npmjs.com.
 * These tests pin each place, using the repository's real files.
 */

const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

/** The files a release plan looks at, read from the repository as it is. */
function repoFiles() {
  const files = {}
  for (const path of [
    'packages/cli/package.json',
    'packages/kernel/package.json',
    'packages/kernel/src/contract.ts',
    'packages/plugins/markdown/package.json',
    'apps/web/package.json',
    'docs/contract.md',
    'docs/features.md',
    'AGENTS.md',
    'README.md',
  ]) {
    files[path] = read(path)
  }
  return files
}

test('versions: parse, reject suffixes, and only move the last number', () => {
  assert.equal(parseVersion('0.0.3'), '0.0.3')
  assert.equal(parseVersion('v0.0.3'), '0.0.3')
  assert.equal(parseVersion(' 0.0.3 '), '0.0.3')
  // A prerelease would keep `npm i -g` from resolving it as latest (m8 §1).
  assert.throws(() => parseVersion('0.0.3-beta'), /not a version/)
  assert.throws(() => parseVersion('1.0'), /not a version/)
  assert.equal(nextVersion('0.0.2'), '0.0.3')
  assert.equal(nextVersion('0.0.9'), '0.0.10')
})

test('contract range: pre-1.0 breaks at the next minor, not the next major', () => {
  // `<1.0.0` would silently accept an incompatible kernel.
  assert.equal(contractRange('0.0.3'), '>=0.0.3 <0.1.0')
  assert.equal(contractRange('0.0.2'), '>=0.0.2 <0.1.0')
  assert.equal(contractRange('1.2.3'), '>=1.2.3 <2.0.0')
})

test('current version comes from the published manifest', () => {
  assert.equal(currentVersion(repoFiles()), '0.0.2')
})

test('the plan edits every manifest, the contract, and every doc that quotes it', () => {
  const files = repoFiles()
  const edits = releaseEdits({ files, version: '0.0.3' })
  const paths = edits.map(edit => edit.path)

  for (const required of [
    'packages/cli/package.json',
    'packages/kernel/package.json',
    'packages/plugins/markdown/package.json',
    'packages/kernel/src/contract.ts',
    'docs/contract.md',
    'docs/features.md',
    'AGENTS.md',
    'README.md',
  ]) {
    assert.ok(paths.includes(required), `${required} is not in the plan`)
  }

  // The page shell is never published: its 0.0.0 is not a release number.
  assert.ok(!paths.includes('apps/web/package.json'), 'apps/web should not be bumped')
})

test('no version is left behind: every planned file is actually at the new number', () => {
  const files = repoFiles()
  const edits = releaseEdits({ files, version: '0.0.3' })
  const after = { ...files }
  for (const edit of edits) after[edit.path] = edit.after

  assert.equal(JSON.parse(after['packages/cli/package.json']).version, '0.0.3')
  assert.equal(JSON.parse(after['packages/plugins/markdown/package.json']).diorama.contract, '>=0.0.3 <0.1.0')
  assert.match(after['packages/kernel/src/contract.ts'], /CONTRACT_VERSION = '0\.0\.3'/)
  assert.match(after['packages/kernel/src/contract.ts'], /CONTRACT_RANGE = '>=0\.0\.3 <0\.1\.0'/)

  // Every mention outside the changelog tables of past versions must have
  // moved. This is the check that caught a stale `v0.0.2` in AGENTS.md and a
  // missed range in contract.md's manifest sample.
  for (const path of ['docs/contract.md', 'docs/features.md', 'AGENTS.md', 'README.md']) {
    const stale = after[path].match(/0\.0\.2/g) ?? []
    // `docs/contract.md` keeps its history sections (§12–§22), which are a
    // record of past releases; every other file should have none left.
    if (path !== 'docs/contract.md') {
      assert.equal(stale.length, 0, `${path} still quotes 0.0.2 ${stale.length} time(s)`)
    }
  }
  // The two places a reader is told the *current* version must be new.
  assert.match(after['docs/contract.md'], /^# 插件契约 v0\.0\.3$/m)
  assert.match(after['docs/contract.md'], /内核契约版本 `0\.0\.3`/)
  assert.match(after['docs/contract.md'], /所有插件声明 `contract: ">=0\.0\.3 <0\.1\.0"`/)
  assert.match(after['docs/contract.md'], /插件写窄范围（当前 `>=0\.0\.3 <0\.1\.0`）/)
  assert.match(after['docs/contract.md'], /当前范围（`0\.0\.3` 起为 `>=0\.0\.3 <0\.1\.0`）/)
  // §1's copy-me manifest sample.
  assert.match(after['docs/contract.md'], /"contract": ">=0\.0\.3 <0\.1\.0"/)
  // The doc comment above the constants.
  assert.match(after['packages/kernel/src/contract.ts'], /\(`>=0\.0\.3 <0\.1\.0`\), so a published kernel/)
})

test('the changelog tables of past versions are not rewritten', () => {
  const files = repoFiles()
  const edits = releaseEdits({ files, version: '0.0.3' })
  const contract = edits.find(edit => edit.path === 'docs/contract.md').after
  // §19 is the record of what 0.0.2 contained — a release must not touch it.
  assert.match(contract, /v0\.8 → v0\.9 变更清单（已计入 `0\.0\.2`）/)
  assert.match(contract, /\| contract version \| `0\.0\.1` \/ `>=0\.0\.1 <0\.1\.0` \| `0\.0\.2` \/ `>=0\.0\.2 <0\.1\.0`/)
})

test('re-running a release is idempotent', () => {
  const files = repoFiles()
  const first = releaseEdits({ files, version: '0.0.3' })
  const after = { ...files }
  for (const edit of first) after[edit.path] = edit.after
  assert.deepEqual(releaseEdits({ files: after, version: '0.0.3' }), [])
})

test('changelog: conventional types become sections, the rest is kept', () => {
  const entry = changelogEntry({
    version: '0.0.3',
    date: '2026-10-21',
    commits: [
      'feat(cli): print the mount as one JSON document',
      'fix(markdown): a relative link opens a tab',
      'a subject with no type',
      'feat!: a breaking one',
    ],
  })
  assert.match(entry, /^## 0\.0\.3 \(2026-10-21\)/)
  assert.match(entry, /### Features\n\n- \*\*cli:\*\* print the mount as one JSON document\n- a breaking one/)
  assert.match(entry, /### Fixes\n\n- \*\*markdown:\*\* a relative link opens a tab/)
  // Never dropped, just unclassified.
  assert.match(entry, /### Other\n\n- a subject with no type/)
})

test('changelog: a new entry goes directly under the preamble', () => {
  const first = insertChangelog(undefined, '## 0.0.2 (2026-10-20)\n\n- old\n')
  assert.ok(first.startsWith(PREAMBLE))
  const second = insertChangelog(first, '## 0.0.3 (2026-10-21)\n\n- new\n')
  const newest = second.indexOf('## 0.0.3')
  const older = second.indexOf('## 0.0.2')
  assert.ok(newest !== -1 && older !== -1 && newest < older, 'the newest release must come first')
})

test('tarball: the files npm needs, and none it must not have', () => {
  const good = {
    files: [
      'README.md',
      'LICENSE',
      'package.json',
      'bin/diorama',
      'web/index.html',
      'plugins/markdown/package.json',
      'plugins/markdown/lib/client.cjs',
    ],
    version: '0.0.3',
    contract: '0.0.3',
    publicManifest: { version: '0.0.3', dependencies: { cordis: '4.0.0-rc.11' } },
  }
  assert.deepEqual(verifyTarball(good), [])

  // Each of these shipped broken once (docs/m8/spec.md §5).
  const missingReadme = { ...good, files: good.files.filter(file => file !== 'README.md') }
  assert.match(verifyTarball(missingReadme).join('\n'), /missing README\.md/)

  const workspaceDep = { ...good, publicManifest: { version: '0.0.3', dependencies: { 'diorama-kernel': 'workspace:*' } } }
  assert.match(verifyTarball(workspaceDep).join('\n'), /third-party only: diorama-kernel@workspace:\*/)

  const staleTag = { ...good, version: '0.0.4' }
  assert.match(verifyTarball(staleTag).join('\n'), /package\.json says 0\.0\.3, the tag says 0\.0\.4/)
})

test('version problems: every manifest and the contract must agree with the tag', () => {
  const entries = [
    { path: 'packages/cli/package.json', parsed: { version: '0.0.3' } },
    { path: 'packages/plugins/markdown/package.json', parsed: { version: '0.0.3', diorama: { contract: '>=0.0.3 <0.1.0' } } },
    // The page shell is exempt.
    { path: 'apps/web/package.json', parsed: { version: '0.0.0' } },
  ]
  assert.deepEqual(versionProblems({ version: '0.0.3', contract: '0.0.3', entries }), [])

  const stale = [
    { path: 'packages/cli/package.json', parsed: { version: '0.0.2' } },
    { path: 'packages/plugins/markdown/package.json', parsed: { version: '0.0.3', diorama: { contract: '>=0.0.2 <0.1.0' } } },
  ]
  const problems = versionProblems({ version: '0.0.3', contract: '0.0.2', entries: stale }).join('\n')
  assert.match(problems, /cli\/package\.json: version is 0\.0\.2/)
  assert.match(problems, /contract is ">=0\.0\.2 <0\.1\.0"/)
  assert.match(problems, /CONTRACT_VERSION is 0\.0\.2/)
})
