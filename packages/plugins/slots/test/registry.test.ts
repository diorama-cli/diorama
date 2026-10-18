import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SlotConflictError, SlotRegistry } from '../src/registry.ts'
import { chooseRenderer } from '../src/select.ts'

const Head = () => null

function registry(warns: string[] = []): SlotRegistry {
  return new SlotRegistry({ warn: message => warns.push(message) })
}

test('slots.register: a duplicate id throws (contract §3.3)', () => {
  const r = registry()
  r.register({ id: 'x:a', name: 'root' }, Head)
  assert.throws(() => r.register({ id: 'x:a', name: 'root' }, Head), SlotConflictError)
})

test('slots.register: entries in one seat coexist as a chain, order then id', () => {
  const r = registry()
  r.register({ id: 'p:owner', name: 'root', order: 0, declare: { 'file.renderer': { kind: 'keyed' } } }, Head)
  r.register({ id: 'b:renderer', name: 'file.renderer', key: 'b', order: 50 }, Head)
  r.register({ id: 'a:renderer', name: 'file.renderer', key: 'a', order: 50 }, Head)
  r.register({ id: 'c:renderer', name: 'file.renderer', key: 'c', order: 10 }, Head)
  const entries = r.all().filter(entry => entry.name === 'file.renderer')
  assert.deepEqual(entries.map(entry => entry.id), ['c:renderer', 'a:renderer', 'b:renderer'])
})

test('slots.register: an equal order is kept and warns', () => {
  const warns: string[] = []
  const r = registry(warns)
  r.register({ id: 'p:owner', name: 'root', declare: { 'file.renderer': { kind: 'keyed' } } }, Head)
  r.register({ id: 'a:x', name: 'file.renderer', key: 'a', order: 7 }, Head)
  r.register({ id: 'b:x', name: 'file.renderer', key: 'b', order: 7 }, Head)
  assert.ok(warns.some(message => message.includes('several entries with order 7')))
  assert.equal(r.all().filter(entry => entry.name === 'file.renderer').length, 2)
})

test('slots.register: a keyed entry without a key is refused and warns', () => {
  const warns: string[] = []
  const r = registry(warns)
  r.register({ id: 'p:owner', name: 'root', declare: { 'file.renderer': { kind: 'keyed' } } }, Head)
  r.register({ id: 'a:x', name: 'file.renderer' }, Head)
  assert.equal(r.all().filter(entry => entry.name === 'file.renderer').length, 0)
  assert.ok(warns.some(message => message.includes('requires a key')))
})

test('slots.declare: an entry registered before its seat is declared lands later', () => {
  const r = registry()
  r.register({ id: 'plain:text', name: 'file.renderer', key: 'plain' }, Head)
  assert.equal(r.entriesOf('file.renderer', 'plain').length, 0)
  r.declare({ 'file.renderer': { kind: 'keyed' } })
  assert.deepEqual(r.entriesOf('file.renderer', 'plain').map(entry => entry.id), ['plain:text'])
})

test('chooseRenderer: ext beats mime, both beat probe, fallback last', async () => {
  const file = { path: 'notes.txt', name: 'notes.txt', kind: 'file' as const, size: 3, mtime: 0 }
  const base = [
    { id: 'fallback', order: 1000 },
    { id: 'by-mime', order: 1, matcher: { mime: ['text/plain'] } },
    { id: 'by-ext', order: 200, matcher: { ext: ['txt'] } },
    { id: 'by-probe', order: 0, matcher: { probe: () => true, cost: 'cheap' as const } },
  ]
  assert.deepEqual(await chooseRenderer(base, { file, mime: 'text/plain' }), { kind: 'match', id: 'by-ext', tier: 'ext' })
  assert.deepEqual(await chooseRenderer(base, { file: { ...file, path: 'x.zzz' }, mime: 'text/plain' }), {
    kind: 'match',
    id: 'by-mime',
    tier: 'mime',
  })
  assert.deepEqual(await chooseRenderer(base.slice(0, 1).concat(base.slice(3)), { file, mime: 'a/b' }), {
    kind: 'match',
    id: 'by-probe',
    tier: 'probe',
  })
  assert.deepEqual(await chooseRenderer([base[0]!], { file, mime: 'a/b' }), { kind: 'fallback', id: 'fallback' })
})

test('chooseRenderer: no entries, no match and no fallback are distinct answers', async () => {
  const file = { path: 'a.unknown', name: 'a.unknown', kind: 'file' as const, size: 0, mtime: 0 }
  assert.deepEqual(await chooseRenderer([], { file, mime: 'a/b' }), { kind: 'empty' })
  assert.deepEqual(await chooseRenderer([{ id: 'x', order: 1, matcher: { ext: ['md'] } }], { file, mime: 'a/b' }), {
    kind: 'no-match',
  })
})

test('chooseRenderer: expensive probes only run after ext/mime miss', async () => {
  const file = { path: 'a.dat', name: 'a.dat', kind: 'file' as const, size: 1, mtime: 0 }
  let probes = 0
  const candidates = [
    { id: 'late', order: 1, matcher: { probe: () => { probes++; return false }, cost: 'expensive' as const } },
    { id: 'fallback', order: 9 },
  ]
  await chooseRenderer(candidates, { file, mime: 'text/plain' }, { head: async () => new Uint8Array() })
  assert.equal(probes, 1)
  await chooseRenderer([{ id: 'e', order: 0, matcher: { ext: ['dat'] } }, ...candidates], { file, mime: 'text/plain' })
  assert.equal(probes, 1)
})
