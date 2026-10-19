import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FsService } from '../src/server/fs.ts'
import type { FsWatchEvent } from '../src/shared/types.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'diorama-watch-'))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'a.txt'), 'one\n')
  return root
}

/** Wait until `predicate` holds, or fail after `timeout` ms. */
async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for the watch event')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('watch: a save burst collapses to one change per window', async t => {
  const root = fixture()
  // The contract's window is 300ms: writes spaced ~20ms apart all land inside
  // one trailing window, so the burst is a single event.
  const fs = new FsService(root, { debounceMs: 300 })
  const events: FsWatchEvent[] = []
  const dispose = fs.watch('', event => events.push(event))
  t.after(() => {
    dispose()
    rmSync(root, { recursive: true, force: true })
  })

  for (let index = 0; index < 5; index++) {
    writeFileSync(join(root, 'a.txt'), `burst ${index}\n`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await until(() => events.length > 0)
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(events.length, 1, 'five writes inside one window collapse to one event')
  assert.deepEqual(events[0], { type: 'change', path: 'a.txt' })
})

test('watch: creates and deletes arrive for the directory that changed', async t => {
  const root = fixture()
  const fs = new FsService(root, { debounceMs: 40 })
  const events: FsWatchEvent[] = []
  const dispose = fs.watch('sub', event => events.push(event))
  t.after(() => {
    dispose()
    rmSync(root, { recursive: true, force: true })
  })

  writeFileSync(join(root, 'sub', 'new.md'), '# new\n')
  await until(() => events.some(event => event.path === 'sub/new.md'))
  // The kind is a hint (a re-stat decides); within a window a create + write
  // is merged into one event, which may read as `add` or `change`.
  assert.ok(['add', 'change'].includes(events.find(event => event.path === 'sub/new.md')?.type ?? ''))

  rmSync(join(root, 'sub', 'new.md'))
  await until(() => events.filter(event => event.path === 'sub/new.md').length >= 2)
  assert.equal(events.filter(event => event.path === 'sub/new.md').at(-1)?.type, 'unlink')
})

test('watch: ignored entries are not reported', async t => {
  // An empty directory: a pre-existing file would also be reported as changed,
  // which is unrelated noise here.
  const root = mkdtempSync(join(tmpdir(), 'diorama-watch-'))
  mkdirSync(join(root, 'node_modules'))
  const fs = new FsService(root, { debounceMs: 30, ignore: ['node_modules', '*.log'] })
  const events: FsWatchEvent[] = []
  const dispose = fs.watch('', event => events.push(event))
  t.after(() => {
    dispose()
    rmSync(root, { recursive: true, force: true })
  })

  writeFileSync(join(root, 'debug.log'), 'noise\n')
  writeFileSync(join(root, 'node_modules', 'x.js'), 'x\n')
  // Space the writes out so each lands in its own watch window.
  await new Promise(resolve => setTimeout(resolve, 120))
  writeFileSync(join(root, 'visible.txt'), 'yes\n')
  await until(() => events.some(event => event.path === 'visible.txt'))
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(
    events.every(event => event.path === 'visible.txt'),
    `only the visible entry is reported, got ${JSON.stringify(events)}`,
  )
})

test('watch: the disposer stops events and is idempotent', async t => {
  const root = fixture()
  const fs = new FsService(root, { debounceMs: 20 })
  const events: FsWatchEvent[] = []
  const dispose = fs.watch('', event => events.push(event))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeFileSync(join(root, 'a.txt'), 'first\n')
  await until(() => events.length > 0)
  dispose()
  const seen = events.length
  writeFileSync(join(root, 'a.txt'), 'second\n')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(events.length, seen)
  dispose() // second call is harmless
})

test('watch: disabled and invalid paths', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const off = new FsService(root, { enabled: false })
  const dispose = off.watch('', () => {
    throw new Error('watch must not emit when disabled')
  })
  assert.equal(typeof dispose, 'function')
  dispose()

  const fs = new FsService(root)
  assert.throws(() => fs.watch('../outside', () => {}), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'EOUTSIDE')
    return true
  })
  fs.watch('', () => {})() // and a valid root is fine
})
