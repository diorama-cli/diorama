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

test('watch: subscriptions to one directory share one OS watcher and one window', async t => {
  const root = fixture()
  const fs = new FsService(root, { debounceMs: 100 })
  t.after(() => fs.close())
  const first: FsWatchEvent[] = []
  const second: FsWatchEvent[] = []
  const stopFirst = fs.watch('', event => first.push(event))
  const stopSecond = fs.watch('', event => second.push(event))
  assert.equal(fs.watchedDirectories, 1, 'two subscriptions, one watched directory')

  writeFileSync(join(root, 'a.txt'), 'two\n')
  await until(() => first.length > 0 && second.length > 0)
  // Both listeners saw the same (merged) event.
  assert.deepEqual(first, second)
  assert.equal(first.length, 1)

  // Releasing the first subscription keeps the watcher for the second.
  stopFirst()
  assert.equal(fs.watchedDirectories, 1)
  writeFileSync(join(root, 'a.txt'), 'three\n')
  await until(() => second.length > 1)
  assert.equal(first.length, 1, 'a disposed listener hears nothing more')
  stopSecond()
  assert.equal(fs.watchedDirectories, 0, 'the last subscriber closes the watcher')
})

test('watch: different directories on one mount get their own watcher', async t => {
  const root = fixture()
  const fs = new FsService(root, { debounceMs: 100 })
  t.after(() => fs.close())
  const atRoot: FsWatchEvent[] = []
  const atSub: FsWatchEvent[] = []
  const stopA = fs.watch('', event => atRoot.push(event))
  const stopB = fs.watch('sub', event => atSub.push(event))
  assert.equal(fs.watchedDirectories, 2)
  // A file created inside `sub/` belongs to the watcher of `sub` (the root
  // watcher only reports its own direct entries, contract.md §3.1).
  // Let the fixture's own write settle first: macOS may report `a.txt` late.
  await new Promise(resolve => setTimeout(resolve, 200))
  atRoot.length = 0
  writeFileSync(join(root, 'sub', 'b.txt'), 'x\n')
  await until(() => atSub.length > 0)
  assert.deepEqual(atSub.map(event => event.path), ['sub/b.txt'])
  assert.equal(atRoot.some(event => event.path.startsWith('sub/')), false, 'the root watcher does not report a grandchild')

  // A direct child of the root is reported by the root watcher.
  writeFileSync(join(root, 'top.txt'), 'x\n')
  await until(() => atRoot.some(event => event.path === 'top.txt'))
  stopA()
  stopB()
  assert.equal(fs.watchedDirectories, 0)
})

test('watch: past maxDirectories a subscription is a no-op with one warning', async t => {
  const root = fixture()
  for (const name of ['d1', 'd2', 'd3']) mkdirSync(join(root, name))
  const warnings: string[] = []
  const fs = new FsService(root, { debounceMs: 50, maxDirectories: 2, warn: message => warnings.push(message) })
  t.after(() => fs.close())
  const stops = ['', 'd1', 'd2'].map(path => fs.watch(path, () => {}))
  assert.equal(fs.watchedDirectories, 2, 'the third directory is not watched')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /2 directories already watched/)

  // A no-op disposer is safe to call.
  stops[2]?.()
  stops[2]?.()

  // Freeing a watcher lets a later subscription take the slot.
  stops[0]?.()
  assert.equal(fs.watchedDirectories, 1)
  const stop = fs.watch('d3', () => {})
  assert.equal(fs.watchedDirectories, 2)
  stop()
  stops[1]?.()
})

test('watch: two mounts never share a watcher (plan.md risk: multi-directory watch)', async t => {
  const first = fixture()
  const second = fixture()
  t.after(() => rmSync(first, { recursive: true, force: true }))
  t.after(() => rmSync(second, { recursive: true, force: true }))
  const a = new FsService(first, { debounceMs: 50 })
  const b = new FsService(second, { debounceMs: 50 })
  t.after(() => a.close())
  t.after(() => b.close())
  // Let the fixture's own writes settle: macOS may report them late, after the
  // watchers below exist, which would look like cross-mount leakage.
  await new Promise(resolve => setTimeout(resolve, 150))
  const seenA: FsWatchEvent[] = []
  const seenB: FsWatchEvent[] = []
  a.watch('', event => seenA.push(event))
  b.watch('', event => seenB.push(event))
  assert.equal(a.watchedDirectories, 1)
  assert.equal(b.watchedDirectories, 1)
  writeFileSync(join(first, 'a.txt'), 'only a\n')
  await until(() => seenA.length > 0)
  assert.deepEqual(seenB, [], 'a change in mount A is invisible to mount B')
  assert.equal(seenA[0]?.path, 'a.txt')
})
