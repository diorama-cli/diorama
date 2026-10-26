import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MountStatus } from 'diorama-kernel/server'
import { noMountMessage, parseStopArgs, planStop, stopDocument, stopLines, stopPath } from '../src/stop.ts'

/**
 * diorama stop [dir] [--all] (contract.md 7.6): the selection rules and the
 * two output shapes.
 */

function mount(overrides: Partial<MountStatus> = {}): MountStatus {
  return {
    mountId: 'abc12345',
    root: '/tmp/proj',
    port: 54321,
    url: 'http://127.0.0.1:54321/',
    state: 'ok',
    since: 1_700_000_000_000,
    plugins: ['slots'],
    hidden: ['.git'],
    ...overrides,
  }
}

const PROJ = mount()
const NOTES = mount({ mountId: 'def67890', root: '/tmp/notes', port: 54322, url: 'http://127.0.0.1:54322/' })

test('parse: no argument, one directory, --all, --json', () => {
  assert.deepEqual(parseStopArgs([]), { options: { all: false, json: false } })
  assert.deepEqual(parseStopArgs(['/tmp/proj']), { options: { target: '/tmp/proj', all: false, json: false } })
  assert.deepEqual(parseStopArgs(['--all', '--json']), { options: { all: true, json: true } })
})

test('parse: unknown options, two directories and "--all + dir" are usage errors', () => {
  assert.match(parseStopArgs(['--nope']).error ?? '', /unknown option "--nope"/)
  assert.match(parseStopArgs(['/a', '/b']).error ?? '', /one directory/)
  assert.match(parseStopArgs(['/a', '--all']).error ?? '', /either a directory or --all/)
})

test('stopPath: no argument means the current directory', () => {
  assert.equal(stopPath(undefined, '/tmp/proj/src'), '/tmp/proj/src')
  assert.equal(stopPath('.', '/tmp/proj/src'), '/tmp/proj/src')
  assert.equal(stopPath('..', '/tmp/proj/src'), '/tmp/proj')
  assert.equal(stopPath('/abs/dir', '/tmp/proj'), '/abs/dir')
})

test('plan: an exact mount root stops that one mount', () => {
  const { plan } = planStop([PROJ, NOTES], { target: '/tmp/proj', all: false, json: false }, { resolved: '/tmp/proj' })
  assert.deepEqual(plan?.mounts.map(entry => entry.mountId), ['abc12345'])
  assert.equal(plan?.target, '/tmp/proj')
  assert.equal(plan?.containing, undefined)
})

test('plan: a path inside a mount stops the mount containing it', () => {
  const { plan } = planStop([PROJ, NOTES], { target: '/tmp/proj/src/deep', all: false, json: false }, { resolved: '/tmp/proj/src/deep' })
  assert.deepEqual(plan?.mounts.map(entry => entry.mountId), ['abc12345'])
  assert.equal(plan?.containing, '/tmp/proj')
})

test('plan: a sibling whose name shares a prefix is not "inside"', () => {
  // /tmp/proj2 must not match the mount of /tmp/proj (separator-aware).
  const { plan, error } = planStop([PROJ], { target: '/tmp/proj2', all: false, json: false }, { resolved: '/tmp/proj2' })
  assert.equal(plan, undefined)
  assert.equal(error, 'ENOMOUNT')
})

test('plan: realpath wins over the typed path (symlinked directory)', () => {
  const { plan } = planStop([PROJ], { target: '/tmp/link-to-proj', all: false, json: false }, { resolved: '/tmp/link-to-proj', real: '/tmp/proj' })
  assert.deepEqual(plan?.mounts.map(entry => entry.mountId), ['abc12345'])
  // The reported target stays what the user typed (resolved, not realpath'd).
  assert.equal(plan?.target, '/tmp/link-to-proj')
})

test('plan: a deleted directory still matches by the plain resolved path', () => {
  const { plan } = planStop([PROJ], { target: '/tmp/proj', all: false, json: false }, { resolved: '/tmp/proj' })
  assert.deepEqual(plan?.mounts.map(entry => entry.mountId), ['abc12345'])
})

test('plan: nested mounts — the deepest containing mount wins', () => {
  const inner = mount({ mountId: 'inner001', root: '/tmp/proj/vendor/lib', port: 54323, url: 'http://127.0.0.1:54323/' })
  const { plan } = planStop([PROJ, inner], { target: '/tmp/proj/vendor/lib/pkg', all: false, json: false }, { resolved: '/tmp/proj/vendor/lib/pkg' })
  assert.deepEqual(plan?.mounts.map(entry => entry.mountId), ['inner001'])
})

test('plan: a mount *inside* the target is not touched from above', () => {
  // Stopping /tmp/proj stops the mount of /tmp/proj, not the nested one.
  const inner = mount({ mountId: 'inner001', root: '/tmp/proj/vendor/lib', port: 54323, url: 'http://127.0.0.1:54323/' })
  const { plan } = planStop([PROJ, inner], { target: '/tmp/proj', all: false, json: false }, { resolved: '/tmp/proj' })
  assert.deepEqual(plan?.mounts.map(entry => entry.mountId), ['abc12345'])
})

test('plan: --all takes every mount, in mount order (empty is not an error)', () => {
  const all = planStop([PROJ, NOTES], { all: true, json: false }, { resolved: '' })
  assert.deepEqual(all.plan?.mounts.map(entry => entry.mountId), ['abc12345', 'def67890'])
  assert.equal(all.plan?.all, true)
  const none = planStop([], { all: true, json: false }, { resolved: '' })
  assert.deepEqual(none.plan?.mounts, [])
})

test('plan: nothing matches — ENOMOUNT, not a crash', () => {
  const { plan, error } = planStop([PROJ], { target: '/elsewhere', all: false, json: false }, { resolved: '/elsewhere' })
  assert.equal(plan, undefined)
  assert.equal(error, 'ENOMOUNT')
})

test('lines: one mount prints its root, id and URL', () => {
  const { plan } = planStop([PROJ], { target: '/tmp/proj', all: false, json: false }, { resolved: '/tmp/proj' })
  assert.deepEqual(stopLines(plan!, 'diorama-beta'), [
    'diorama-beta stopped /tmp/proj',
    '  [mount:abc12345] http://127.0.0.1:54321/',
  ])
})

test('lines: a path inside a mount says which mount it matched', () => {
  const { plan } = planStop([PROJ], { target: '/tmp/proj/src', all: false, json: false }, { resolved: '/tmp/proj/src' })
  assert.deepEqual(stopLines(plan!).at(-1), '  (matched the mount containing /tmp/proj/src)')
})

test('lines: --all lists every stopped mount; none reads "no mounts to stop"', () => {
  const all = planStop([PROJ, NOTES], { all: true, json: false }, { resolved: '' }).plan!
  assert.deepEqual(stopLines(all), [
    'diorama stopped 2 mounts',
    '  [abc12345] /tmp/proj  http://127.0.0.1:54321/',
    '  [def67890] /tmp/notes  http://127.0.0.1:54322/',
  ])
  assert.deepEqual(stopLines({ all: true, mounts: [] }), ['no mounts to stop'])
})

test('document: one object with the stopped mounts, their URLs and the target', () => {
  const { plan } = planStop([PROJ], { target: '/tmp/proj', all: false, json: false }, { resolved: '/tmp/proj' })
  assert.deepEqual(stopDocument(plan!), {
    stopped: [{ mountId: 'abc12345', root: '/tmp/proj', url: 'http://127.0.0.1:54321/' }],
    target: '/tmp/proj',
    all: false,
  })
  const all = stopDocument(planStop([PROJ], { all: true, json: false }, { resolved: '' }).plan!)
  assert.equal(all.target, null)
  assert.equal(all.all, true)
  assert.equal(JSON.stringify(stopDocument(plan!)).includes('\n'), false, 'one line on stdout')
})

test('document: a partial run only carries what really stopped', () => {
  const plan = { all: true, mounts: [PROJ], target: undefined }
  assert.deepEqual(stopDocument(plan).stopped, [{ mountId: 'abc12345', root: '/tmp/proj', url: 'http://127.0.0.1:54321/' }])
})

test('no mount: names the target and points at "ls", listing what is mounted', () => {
  assert.deepEqual(noMountMessage('/tmp/typo', [PROJ, NOTES]), [
    'no mount for "/tmp/typo" (run "diorama ls" to see the mounts)',
    '  [abc12345] /tmp/proj',
    '  [def67890] /tmp/notes',
  ])
  assert.deepEqual(noMountMessage('/tmp/typo', [], 'diorama-beta'), [
    'no mount for "/tmp/typo" (run "diorama-beta ls" to see the mounts)',
  ])
})
