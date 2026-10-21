import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MountStatus } from 'diorama-kernel/server'
import { mountDocument, mountLines, type MountOutput } from '../src/mount-output.ts'

/**
 * `diorama <dir> --json` (contract.md §7.6): the two output shapes. Other
 * programs parse the JSON, so its keys are asserted here rather than only
 * through the CLI's end-to-end tests.
 */

function mount(overrides: Partial<MountStatus> = {}): MountStatus {
  return {
    mountId: 'abc12345',
    root: '/tmp/proj',
    port: 54321,
    url: 'http://127.0.0.1:54321/',
    state: 'ok',
    since: 1_700_000_000_000,
    plugins: ['slots', 'layout'],
    hidden: ['.git', 'node_modules'],
    ...overrides,
  }
}

function output(overrides: Partial<MountOutput> = {}): MountOutput {
  return { mount: mount(), created: true, ...overrides }
}

test('mount lines: the five contract lines, in order', () => {
  assert.deepEqual(mountLines(output()), [
    'diorama serving /tmp/proj',
    '  http://127.0.0.1:54321/',
    '  config: none (defaults)',
    '  [mount:abc12345] plugins: slots, layout',
    '  hidden: .git, node_modules',
  ])
})

test('mount lines: the invoked name is used, and `hidden:` is dropped when empty', () => {
  const lines = mountLines(output({ mount: mount({ hidden: [], configFile: '/tmp/proj/diorama.toml' }) }), 'diorama-beta')
  assert.equal(lines[0], 'diorama-beta serving /tmp/proj')
  assert.equal(lines[2], '  config: /tmp/proj/diorama.toml')
  assert.equal(lines.length, 4)
})

test('mount lines: an existing mount adds the "already mounted" line', () => {
  const lines = mountLines(output({ created: false }), 'diorama-beta')
  assert.equal(lines.at(-1), 'already mounted (run "diorama-beta restart <dir>" to reload)')
})

test('mount lines: no plugins reads "(none)", not an empty string', () => {
  assert.equal(mountLines(output({ mount: mount({ plugins: [] }) }))[3], '  [mount:abc12345] plugins: (none)')
})

test('mount document: one object carrying the URL, and no prose', () => {
  const document = mountDocument(output())
  assert.deepEqual(Object.keys(document).sort(), ['created', 'mount', 'mountId', 'root', 'url'])
  assert.equal(document.url, 'http://127.0.0.1:54321/')
  assert.equal(document.root, '/tmp/proj')
  assert.equal(document.mountId, 'abc12345')
  assert.equal(document.created, true)
  // `mount` is the control plane's MountStatus, verbatim (contract.md §7.3).
  assert.deepEqual(document.mount, mount())
})

test('mount document: `pluginFailures` appears only when the server reported them', () => {
  assert.equal('pluginFailures' in mountDocument(output()), false)
  const failed = mountDocument(output({ pluginFailures: '1 plugin(s) failed:\n  - code: nope' }))
  assert.equal(failed.pluginFailures, '1 plugin(s) failed:\n  - code: nope')
})

test('mount document: `created: false` still carries the existing mount (idempotent re-run)', () => {
  const document = mountDocument(output({ created: false }))
  assert.equal(document.created, false)
  assert.equal(document.url, 'http://127.0.0.1:54321/')
})

test('mount document: JSON round-trips (it is what stdout gets)', () => {
  const text = JSON.stringify(mountDocument(output()))
  assert.equal(text.includes('\n'), false, 'one line: stdout carries exactly one document')
  const parsed = JSON.parse(text) as { url: string; mount: MountStatus }
  assert.equal(parsed.url, 'http://127.0.0.1:54321/')
  assert.equal(parsed.mount.mountId, 'abc12345')
})
