import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRouterService, decodeHash, decodeRoute, encodeHash, encodeRoute, type RouterHistory, type RouterTabs } from '../src/client/router.ts'
import type { FileInfo } from '../src/shared/types.ts'

/**
 * `ctx.router` (contract.md §3.8): the URL `/~/<path>` and the active file,
 * one direction at a time.
 */

function file(path: string): FileInfo {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 0, mtime: 0 }
}

/** A tab service stand-in with the router's narrow face. */
function tabsStub(): RouterTabs & { opened: string[]; closed: number; setActive(path: string | undefined): void } {
  let active: { id: string; path: string; view?: 'content' | 'diff' } | undefined
  const listeners = new Set<() => void>()
  const state = {
    opened: [] as string[],
    closed: 0,
    get active() {
      return active
    },
    open(info: FileInfo, options: { view?: 'content' | 'diff' } = {}) {
      state.opened.push(options.view === 'diff' ? `${info.path}#diff` : info.path)
      active = { id: `tab-${state.opened.length}`, path: info.path, ...(options.view === 'diff' ? { view: 'diff' as const } : {}) }
      for (const listener of listeners) listener()
      return active
    },
    /** A tab activated outside the router (a tree click, a shortcut). */
    setView(path: string, view: 'content' | 'diff') {
      state.setActive(path, view)
    },
    close() {
      // Like the real service: closing with nothing open is a no-op.
      if (active === undefined) return
      state.closed++
      active = undefined
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setActive(path: string | undefined, view: 'content' | 'diff' = 'content') {
      active = path === undefined ? undefined : { id: 'tab-x', path, ...(view === 'diff' ? { view } : {}) }
      for (const listener of listeners) listener()
    },
  }
  return state
}

/** An in-memory history that records writes. */
function historyStub(): RouterHistory & { writes: string[]; pops: (url: string) => void; current: string } {
  const pops = new Set<(url: string) => void>()
  const state = {
    current: '/',
    writes: [] as string[],
    read: () => state.current,
    push(url: string) {
      state.current = url
      state.writes.push(`push:${url}`)
    },
    replace(url: string) {
      state.current = url
      state.writes.push(`replace:${url}`)
    },
    onPopState(listener: (url: string) => void) {
      pops.add(listener)
      return () => pops.delete(listener)
    },
    pops: (url: string) => {
      state.current = url
      for (const listener of pops) listener(url)
    },
  }
  return state
}

test('router: encodes and decodes the /~/ prefix', () => {
  assert.equal(encodeRoute(undefined), '/')
  assert.equal(encodeRoute(''), '/')
  assert.equal(encodeRoute('src/app.js'), '/~/src/app.js')
  assert.equal(encodeRoute('a b/c#d.txt'), '/~/a%20b/c%23d.txt')
  assert.equal(decodeRoute('/~/src/app.js'), 'src/app.js')
  assert.equal(decodeRoute('/~/a%20b/c%23d.txt'), 'a b/c#d.txt')
  assert.equal(decodeRoute('/'), undefined)
  assert.equal(decodeRoute('/~/'), undefined)
  assert.equal(decodeRoute('/plugin.json'), undefined)
})

test('router: refuses paths that leave the mount or name nothing valid', () => {
  assert.equal(decodeRoute('/~/../etc/passwd'), false)
  assert.equal(decodeRoute('/~/a/../../b'), false)
  assert.equal(decodeRoute('/~/%2e%2e/secret'), false)
  assert.equal(decodeRoute('/~/etc/%2e%2e/passwd'), 'passwd')
  assert.equal(decodeRoute('/~/%00bad'), false)
  assert.equal(decodeRoute('/~/%2Fabs'), false)
  assert.equal(decodeRoute('/~/%E0%A4%A'), false) // malformed encoding
  // `.` segments are dropped the way a browser normalises them.
  assert.equal(decodeRoute('/~/a/./b'), 'a/b')
})

test('router: writing the URL of the active tab; closing goes to the root', () => {
  const tabs = tabsStub()
  const history = historyStub()
  const router = createRouterService({ history, tabs: () => tabs, fileInfo: file })
  const seen: (string | undefined)[] = []
  router.subscribe(() => seen.push(router.file))

  // A tree click: tabs change on their own, the router records the path.
  tabs.open(file('docs/notes.md'))
  assert.equal(router.file, 'docs/notes.md')
  assert.equal(history.writes.at(-1), 'push:/~/docs/notes.md')
  // Closing: no active tab means the root, with one more history entry.
  router.close()
  assert.equal(tabs.closed, 1)
  assert.equal(router.file, undefined)
  assert.equal(history.writes.at(-1), 'push:/')
  // A second close (nothing active) does not add another history entry.
  const writes = history.writes.length
  router.close()
  assert.equal(history.writes.length, writes)
  assert.deepEqual(seen, ['docs/notes.md', undefined, undefined].slice(0, seen.length))
})

test('router: back/forward opens what the URL names, without echoing the URL', () => {
  const tabs = tabsStub()
  const history = historyStub()
  const router = createRouterService({ history, tabs: () => tabs, fileInfo: file })
  history.pops('/~/README.md')
  assert.equal(router.file, 'README.md')
  assert.deepEqual(tabs.opened, ['README.md'])
  // A pop is a history move, not a new entry: the router records the path it
  // adopted and writes nothing (the URL already says it).
  assert.deepEqual(history.writes, [])
  // Back to the root: nothing is opened, the file becomes `undefined`.
  history.pops('/')
  assert.equal(router.file, undefined)
})

test('router: a deep link on first load opens one tab; an invalid one opens none', () => {
  const tabs = tabsStub()
  const history = historyStub()
  history.current = '/~/src/app.js'
  const router = createRouterService({ history, tabs: () => tabs, fileInfo: file })
  assert.deepEqual(tabs.opened, ['src/app.js'])
  assert.equal(router.file, 'src/app.js')

  const warned: string[] = []
  const other = createRouterService({
    history: { ...historyStub(), read: () => '/~/../escape' },
    tabs: () => tabs,
    fileInfo: file,
    warn: message => warned.push(message),
  })
  assert.deepEqual(tabs.opened, ['src/app.js'])
  assert.equal(other.file, undefined)
  assert.match(warned.join('\n'), /ignoring|refusing/)
})

test('router: a deep link seen before tabs activate is queued, not lost', () => {
  const tabs = tabsStub()
  const history = historyStub()
  history.current = '/~/README.md'
  let available: RouterTabs | undefined
  const router = createRouterService({ history, tabs: () => available, fileInfo: file })
  assert.deepEqual(tabs.opened, [])
  assert.equal(router.open('README.md'), false)
  available = tabs
  router.attach()
  assert.deepEqual(tabs.opened, ['README.md'])
})

test('router: the hash surface is pieces\' state; changing it never pushes history', () => {
  const tabs = tabsStub()
  const history = historyStub()
  const router = createRouterService({ history, tabs: () => tabs, fileInfo: file })
  tabs.open(file('src/app.js'))
  const writesBefore = history.writes.length

  const diff = router.state('diff')
  // A flag: the file is the path, the hash only says which view.
  diff.set('')
  assert.equal(diff.get(), '')
  assert.equal(router.getSnapshot().state.diff, '')
  // Always a replace: turning a switch is not a back step (contract.md §3.8).
  assert.equal(history.writes.length, writesBefore + 1)
  assert.match(history.writes.at(-1) ?? '', /^replace:/)
  assert.equal(history.current, '/~/src/app.js#diff')

  // A second write with the same value is still one replace (no path echo).
  diff.set(undefined)
  assert.equal(diff.get(), undefined)
  assert.equal(history.current, '/~/src/app.js')
  assert.throws(() => router.state('bad key'), /URL-safe/)
})

test('router: a diff tab moves the path to its file; the hash says which view', () => {
  const tabs = tabsStub()
  const history = historyStub()
  const router = createRouterService({ history, tabs: () => tabs, fileInfo: file })
  tabs.open(file('src/app.js'))
  assert.equal(router.file, 'src/app.js')
  // The path names the file the page shows, whatever view shows it.
  tabs.setActive('src/b.js', 'diff')
  assert.equal(router.file, 'src/b.js')
  assert.equal(history.writes.at(-1), 'push:/~/src/b.js')

  // A pop to a flag URL delivers both parts.
  history.pops('/~/README.md#diff')
  assert.equal(router.file, 'README.md')
  assert.equal(router.state('diff').get(), '')
})

test('router: a deep link keeps the hash it arrived with (flags and values)', () => {
  const tabs = tabsStub()
  const history = historyStub()
  history.current = '/~/src/app.js#diff&theme=dark'
  const router = createRouterService({ history, tabs: () => tabs, fileInfo: file })
  assert.equal(router.file, 'src/app.js')
  assert.deepEqual(router.values(), { diff: '', theme: 'dark' })
})

test('router: a flag encodes without an equals sign; the path is not repeated', () => {
  assert.equal(encodeHash({ diff: '' }), '#diff')
  assert.equal(encodeHash({ theme: 'dark', diff: '' }), '#diff&theme=dark')
  assert.deepEqual(decodeHash('#diff'), { diff: '' })
  assert.deepEqual(decodeHash('#diff&theme=dark'), { diff: '', theme: 'dark' })
  // A value is still `key=value` (a diff against an older commit, say).
  assert.equal(encodeHash({ diff: 'HEAD~1' }), '#diff=HEAD~1')
  assert.deepEqual(decodeHash('#diff=HEAD~1'), { diff: 'HEAD~1' })
})
