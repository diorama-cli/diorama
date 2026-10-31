import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIndexServer, escapeHtml, formatTime, renderIndexPage } from '../src/server/index-page.ts'
import type { MountStatus } from '../src/shared/control.ts'

/**
 * The gateway's index page (contract.md §7.7): every mount with its URL, at a
 * fixed address. The document is a pure function of the mount table, so these
 * tests read the HTML instead of a browser.
 */

const INFO = { pid: 4242, version: '0.0.7', contract: '0.0.7', startedAt: Date.UTC(2026, 10, 1, 2, 3) }

function mount(overrides: Partial<MountStatus> = {}): MountStatus {
  return {
    mountId: 'abc12345',
    root: '/Users/me/proj',
    port: 54321,
    url: 'http://127.0.0.1:54321/',
    state: 'ok',
    since: 1_760_000_000_000,
    plugins: ['slots', 'layout'],
    hidden: ['.git', 'node_modules'],
    ...overrides,
  }
}

test('index page: every mount is a link that opens in a new window', () => {
  const page = renderIndexPage([mount(), mount({ mountId: 'def67890', root: '/Users/me/notes', url: 'http://127.0.0.1:54322/' })], {
    info: INFO,
  })
  // The directory and its URL are both on the page: the two things a reader
  // came for.
  assert.match(page, /data-root="\/Users\/me\/proj"/)
  assert.match(page, /data-url="http:\/\/127\.0\.0\.1:54321\/"/)
  assert.match(page, /href="http:\/\/127\.0\.0\.1:54321\/"/)
  assert.match(page, /href="http:\/\/127\.0\.0\.1:54322\/"/)
  // A click must open a window of its own, not navigate away from the list.
  assert.equal((page.match(/target="_blank"/g) ?? []).length, 2)
  assert.equal((page.match(/rel="noopener"/g) ?? []).length, 2)
  // The mount id is on the row (the CLI speaks in ids).
  assert.match(page, /data-mount-id="def67890"/)
})

test('index page: no mounts is a sentence, not an empty list', () => {
  const page = renderIndexPage([], { info: INFO })
  assert.match(page, /data-testid="gateway-index-empty"/)
  assert.match(page, /No mounts right now/)
  assert.doesNotMatch(page, /class="mounts"/)
})

test('index page: a degraded mount says why, on the row', () => {
  const page = renderIndexPage(
    [mount({ state: 'degraded', lastError: { code: 'EIO', message: 'plugin fs crashed', at: 1 } })],
    { info: INFO },
  )
  assert.match(page, /mount--degraded/)
  assert.match(page, /degraded — plugin fs crashed/)
})

test('index page: the header counts mounts and names the process', () => {
  const page = renderIndexPage([mount(), mount({ mountId: 'x', root: '/a', url: 'http://127.0.0.1:1/' })], { info: INFO })
  assert.match(page, /pid 4242/)
  assert.match(page, /v0\.0\.7/)
  assert.match(page, /2 mounts/)
  // One mount is not "1 mounts".
  assert.match(renderIndexPage([mount()], { info: INFO }), /1 mount ·/)
})

test('index page: values are escaped, so a directory name cannot inject markup', () => {
  const page = renderIndexPage([mount({ root: '/tmp/<script>alert(1)</script>', url: 'http://127.0.0.1:1/"onload="x' })], {
    info: INFO,
  })
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/)
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(page, /"onload="/)
  assert.equal(escapeHtml('a&b<c>"d"\'e\''), 'a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;')
})

test('index page: the control socket is named when the caller knows it', () => {
  const withSocket = renderIndexPage([], { info: INFO, socket: '/Users/me/.diorama/diorama.sock' })
  assert.match(withSocket, /Control socket: <code>\/Users\/me\/\.diorama\/diorama\.sock<\/code>/)
  assert.doesNotMatch(renderIndexPage([], { info: INFO }), /Control socket/)
})

test('index page: the time is the reader\'s clock, zero-padded', () => {
  const text = formatTime(new Date(2026, 0, 2, 3, 4).getTime())
  assert.equal(text, '2026-01-02 03:04')
})

test('index server: the page is rendered per request, so a new mount shows up', async () => {
  const mounts: MountStatus[] = []
  const index = createIndexServer({ list: () => [...mounts], info: INFO })
  const port = await new Promise<number>((resolve, reject) => {
    index.server.once('error', reject)
    index.server.listen(0, '127.0.0.1', () => {
      const address = index.server.address()
      if (address === null || typeof address === 'string') reject(new Error('no port'))
      else resolve(address.port)
    })
  })
  try {
    const first = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    assert.match(first, /No mounts right now/)
    mounts.push(mount())
    const second = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    assert.match(second, /data-root="\/Users\/me\/proj"/)
    assert.doesNotMatch(second, /No mounts right now/)
    // The table is not a cache: it is read again on the next request.
    mounts.length = 0
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /No mounts right now/)
    // Only "/" is a page; anything else is a 404, not the list.
    const missing = await fetch(`http://127.0.0.1:${port}/elsewhere`)
    assert.equal(missing.status, 404)
  } finally {
    await index.close()
  }
})

test('index server: close() resolves even with a keep-alive connection open', async () => {
  const index = createIndexServer({ list: () => [mount()], info: INFO })
  const port = await new Promise<number>((resolve, reject) => {
    index.server.once('error', reject)
    index.server.listen(0, '127.0.0.1', () => {
      const address = index.server.address()
      if (address === null || typeof address === 'string') reject(new Error('no port'))
      else resolve(address.port)
    })
  })
  await fetch(`http://127.0.0.1:${port}/`)
  await index.close()
  // A closed listener refuses the next connection (a kept-alive socket would
  // otherwise make close() hang until the client goes away).
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`))
})
