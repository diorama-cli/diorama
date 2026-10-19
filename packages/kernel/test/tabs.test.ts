import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTabsService } from '../src/client/tabs.ts'
import type { FileInfo } from '../src/shared/types.ts'

function file(path: string): FileInfo {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 1, mtime: 0 }
}

test('tabs: open appends, one tab per path, and activates', () => {
  const tabs = createTabsService()
  const a = tabs.open(file('a.md'))
  const b = tabs.open(file('b.md'))
  assert.equal(tabs.count, 2)
  assert.deepEqual(tabs.getSnapshot().tabs.map(tab => tab.path), ['a.md', 'b.md'])
  assert.equal(tabs.active?.id, b.id)
  // Re-opening an open file activates its tab instead of opening a second one.
  const again = tabs.open(file('a.md'))
  assert.equal(again.id, a.id)
  assert.equal(tabs.count, 2)
  assert.equal(tabs.active?.id, a.id)
  // Ids are fresh per tab and path-only (contract.md §3.4).
  assert.notEqual(a.id, b.id)
  assert.deepEqual(Object.keys(a).sort(), ['id', 'path'])
})

test('tabs: close activates the right neighbour, else the left, else nothing', () => {
  const tabs = createTabsService()
  const a = tabs.open(file('a'))
  const b = tabs.open(file('b'))
  const c = tabs.open(file('c'))
  tabs.activate(b.id)
  tabs.close()
  // b was active: c (right) takes over.
  assert.equal(tabs.active?.id, c.id)
  tabs.activate(c.id)
  tabs.close(c.id)
  // c was last: a? No — its left neighbour is a.
  assert.equal(tabs.active?.id, a.id)
  tabs.close()
  assert.deepEqual(tabs.getSnapshot(), { tabs: [], activeId: undefined })
  // Closing a non-active tab keeps the active one.
  const x = tabs.open(file('x'))
  const y = tabs.open(file('y'))
  tabs.activate(x.id)
  tabs.close(y.id)
  assert.equal(tabs.active?.id, x.id)
  // Closing an unknown id changes nothing.
  const before = tabs.getSnapshot()
  tabs.close('nope')
  assert.equal(tabs.getSnapshot(), before)
})

test('tabs: next / prev wrap around; a single tab does not move', () => {
  const tabs = createTabsService()
  const single = tabs.open(file('solo'))
  tabs.next()
  tabs.prev()
  assert.equal(tabs.active?.id, single.id)

  // Three tabs now: solo, a, b — the wrap goes through solo.
  const a = tabs.open(file('a'))
  const b = tabs.open(file('b'))
  assert.equal(tabs.active?.id, b.id)
  tabs.activate(a.id)
  tabs.next()
  assert.equal(tabs.active?.id, b.id)
  tabs.next()
  assert.equal(tabs.active?.id, single.id)
  tabs.prev()
  assert.equal(tabs.active?.id, b.id)
})

test('tabs: next cycles the whole list back to the first tab', () => {
  const tabs = createTabsService()
  const a = tabs.open(file('a'))
  const b = tabs.open(file('b'))
  tabs.activate(a.id)
  tabs.next()
  assert.equal(tabs.active?.id, b.id)
  tabs.next()
  assert.equal(tabs.active?.id, a.id)
})

test('tabs: snapshots are immutable copies, changes notify once', () => {
  const tabs = createTabsService()
  let calls = 0
  const off = tabs.subscribe(() => calls++)
  const first = tabs.getSnapshot()
  tabs.open(file('a'))
  const second = tabs.getSnapshot()
  assert.notEqual(first, second)
  assert.equal(second.tabs.length, 1)
  // activate to the same tab is not a change.
  const only = tabs.active!.id
  tabs.activate(only)
  assert.equal(calls, 1)
  off()
  tabs.open(file('b'))
  assert.equal(calls, 1)
})

test('tabs: open on a directory is a no-op (or re-activates)', () => {
  const tabs = createTabsService()
  assert.throws(() => tabs.open({ path: 'dir', name: 'dir', kind: 'dir', size: 0, mtime: 0 }), /non-file/)
  const a = tabs.open(file('a'))
  assert.equal(tabs.open({ path: 'dir', name: 'dir', kind: 'dir', size: 0, mtime: 0 }).id, a.id)
})

test('tabs: the key is (path, view) — content and diff tabs coexist', () => {
  const tabs = createTabsService()
  const content = tabs.open(file('src/app.js'))
  const diff = tabs.open(file('src/app.js'), { view: 'diff' })
  assert.notEqual(content.id, diff.id)
  assert.equal(tabs.count, 2)
  assert.equal(tabs.active?.id, diff.id)
  assert.equal(tabs.viewOf(content.id), 'content')
  assert.equal(tabs.viewOf(diff.id), 'diff')
  // Re-opening the same (path, view) activates the existing tab.
  tabs.open(file('src/app.js'), { view: 'diff' })
  assert.equal(tabs.count, 2)
  tabs.open(file('src/app.js'))
  assert.equal(tabs.count, 2)
  assert.equal(tabs.active?.id, content.id)
  // `find` is the key lookup both pieces use.
  assert.equal(tabs.find('src/app.js')?.id, content.id)
  assert.equal(tabs.find('src/app.js', 'diff')?.id, diff.id)
  assert.equal(tabs.find('src/other.js'), undefined)
})
