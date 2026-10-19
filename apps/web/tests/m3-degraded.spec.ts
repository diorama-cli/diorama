import { expect, test } from '@playwright/test'
import { fixture, startGateway, waitForPage, type GatewayFixture } from './support.ts'

/**
 * M3 S5 (contract.md §11.1): a degraded mount keeps serving, shows a banner on
 * its page, appears as `degraded` in `ls`, is restarted once automatically, and
 * leaves its neighbours alone. The failure is injected through the gateway's
 * test hook (`fail`, only with DIORAMA_TEST_HOOKS=1).
 */

let gateway: GatewayFixture | undefined

test.beforeAll(async () => {
  gateway = await startGateway({ env: { DIORAMA_TEST_HOOKS: '1' } })
})

test.afterAll(async () => {
  await gateway?.stop()
})

/** One control request, returning its result or its error code. */
async function attempt(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return { ok: true, ...((await gateway!.request(method, params)) as Record<string, unknown>) }
  } catch (failure) {
    return { ok: false, error: (failure as Error).message }
  }
}

test('6. degraded: banner on the affected page, ls says degraded, the neighbour is untouched', async ({ browser }) => {
  const first = fixture({ 'a.md': '# A\n' })
  const second = fixture({ 'b.md': '# B\n' })
  const pageA = await browser.newPage()
  const pageB = await browser.newPage()
  try {
    const a = await gateway!.mount(first.root)
    const b = await gateway!.mount(second.root)
    await pageA.goto(a.url)
    await pageB.goto(b.url)
    await waitForPage(pageA)
    await waitForPage(pageB)
    await expect(pageA.getByTestId('mount-degraded')).toHaveCount(0)

    const injected = await attempt('fail', { mountId: a.mountId, message: 'renamed away: ENOTDIR' })
    expect(injected.ok).toBe(true)
    expect(injected.state).toBe('degraded')
    // The banner appears during the degraded window, before the auto-restart.
    await expect(pageA.getByTestId('mount-degraded')).toContainText('renamed away', { timeout: 1_500 })

    // The neighbour never shows a banner.
    await expect(pageB.getByTestId('mount-degraded')).toHaveCount(0)
    // The degraded page keeps serving files (contract.md §11.1: no blocking).
    const stillReads = await pageA.evaluate(async () => {
      const fs = (globalThis as unknown as { __diorama_page__: { getKernel(): { mount: { fs: { readText(p: string): Promise<string> } } } } }).__diorama_page__.getKernel().mount.fs
      return fs.readText('a.md')
    })
    expect(stillReads).toContain('# A')

    // `list` reports the neighbour healthy throughout; the degraded mount is
    // recovered by its one automatic restart (a new id, §11.1).
    const list = (await gateway!.request('list')) as { mounts: { mountId: string; root: string; state: string }[] }
    expect(list.mounts.find(mount => mount.root === a.root)?.state).toBe('ok')
    expect(list.mounts.find(mount => mount.mountId === b.mountId)?.state).toBe('ok')
  } finally {
    await pageA.close()
    await pageB.close()
    first.dispose()
    second.dispose()
  }
})

test('6b. degraded is restarted once automatically; the mount comes back under a new id', async () => {
  const directory = fixture()
  try {
    const mount = await gateway!.mount(directory.root)
    await attempt('fail', { mountId: mount.mountId })
    // The gateway waits (2s) then remounts in place: a new id and port, `ok`.
    // Wait for the in-place remount: a different id for the same root, `ok`.
    await expect.poll(async () => {
      const list = (await gateway!.request('list')) as { mounts: { mountId: string; root: string; state: string }[] }
      const fresh = list.mounts.find(entry => entry.root === mount.root)
      return fresh === undefined ? 'missing' : `${fresh.mountId !== mount.mountId}:${fresh.state}`
    }, { timeout: 10_000 }).toBe('true:ok')
    const fresh = (await gateway!.request('list')) as { mounts: { mountId: string; root: string }[] }
    expect(fresh.mounts.find(entry => entry.root === mount.root)?.mountId).not.toBe(mount.mountId)
    // The old port is closed; the new URL serves the page.
    const newId = fresh.mounts.find(entry => entry.root === mount.root)?.mountId
    const status = (await gateway!.request('status')) as { mounts: { mountId: string; port: number }[] }
    const freshStatus = status.mounts.find(entry => entry.mountId === newId)
    expect(freshStatus?.port).not.toBe(mount.port)
    const response = await fetch(`http://127.0.0.1:${freshStatus?.port}/plugin.json`)
    expect(response.ok).toBe(true)
    const manifest = (await response.json()) as { state?: string }
    expect(manifest.state).toBe('ok')
  } finally {
    directory.dispose()
  }
})

test('6c. a second degradation does not restart again (no restart storm); `restart <dir>` recovers it', async () => {
  const directory = fixture()
  try {
    const mount = await gateway!.mount(directory.root)
    await attempt('fail', { mountId: mount.mountId })
    await expect.poll(async () => {
      const list = (await gateway!.request('list')) as { mounts: { mountId: string; root: string }[] }
      return list.mounts.some(entry => entry.root === mount.root && entry.mountId !== mount.mountId)
    }, { timeout: 10_000 }).toBe(true)
    const remounted = (await gateway!.request('list')) as { mounts: { mountId: string; root: string }[] }
    const freshId = remounted.mounts.find(entry => entry.root === mount.root)!.mountId
    await attempt('fail', { mountId: freshId })
    // Wait past the restart delay: the mount stays degraded with the same id.
    await new Promise(resolve => setTimeout(resolve, 2_500))
    const after = (await gateway!.request('list')) as { mounts: { mountId: string; state: string }[] }
    const entry = after.mounts.find(candidate => candidate.mountId === freshId)
    expect(entry?.state).toBe('degraded')
    // Manual recovery: unmount + mount again.
    await attempt('unmount', { mountId: freshId })
    const recovered = await gateway!.mount(directory.root)
    expect(recovered.state).toBe('ok')
    expect(recovered.mountId).not.toBe(freshId)
  } finally {
    directory.dispose()
  }
})

test('6d. without DIORAMA_TEST_HOOKS the `fail` method does not exist', async () => {
  const plain = await startGateway()
  try {
    await expect(plain.request('fail', { mountId: 'x' })).rejects.toThrow(/EMETHOD/)
  } finally {
    await plain.stop()
  }
})
