import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { fixture, startGateway, waitForPage, type GatewayFixture } from './support.ts'

/**
 * M3 S2 (docs/m3/spec.md §2, contract.md §7): one resident gateway serves two
 * directories on two ports. Each page reads its own directory and nothing
 * else; mounting the same directory again is idempotent.
 */

let gateway: GatewayFixture | undefined

test.beforeAll(async () => {
  gateway = await startGateway()
})

test.afterAll(async () => {
  await gateway?.stop()
})

test('2. one gateway, two directories, two ports — each page serves its own tree', async ({ browser }) => {
  const first = fixture({ 'only-a.txt': 'from A\n' })
  const second = fixture({ 'only-b.txt': 'from B\n' })
  try {
    const a = await gateway!.mount(first.root)
    const b = await gateway!.mount(second.root)
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(a.state).toBe('ok')
    expect(a.port).not.toBe(b.port)
    expect(a.url).toBe(`http://127.0.0.1:${a.port}/`)
    expect(a.root).toBe(realpathSync(first.root))
    expect(b.root).toBe(realpathSync(second.root))

    // Both pages boot from the same gateway process, each with its own mount.
    for (const [status, ownFile, foreignFile] of [
      [a, 'only-a.txt', 'only-b.txt'],
      [b, 'only-b.txt', 'only-a.txt'],
    ] as const) {
      const page = await browser.newPage()
      try {
        await page.goto(status.url)
        await waitForPage(page)
        const seen = await page.evaluate(async () => {
          const mount = (globalThis as unknown as {
            __diorama_page__: { getKernel(): { mount: { mountId: string; root: string; fs: { list(p?: string): Promise<{ name: string }[]> } } } }
          }).__diorama_page__.getKernel().mount
          return { mountId: mount.mountId, names: (await mount.fs.list('')).map(entry => entry.name) }
        })
        expect(seen.mountId).toBe(status.mountId)
        expect(seen.names).toContain(ownFile)
        expect(seen.names).not.toContain(foreignFile)
        await expect(page.getByTestId('file-tree')).toContainText(ownFile)
        await expect(page.getByTestId('file-tree')).not.toContainText(foreignFile)
      } finally {
        await page.close()
      }
    }
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('2b. mounting the same directory again returns the same mount and URL', async () => {
  const directory = fixture()
  try {
    const first = await gateway!.mount(directory.root)
    const again = await gateway!.mount(directory.root)
    expect(again.created).toBe(false)
    expect(again.mountId).toBe(first.mountId)
    expect(again.url).toBe(first.url)
    // A symlinked spelling resolves to the same directory (realpath is the key).
    const list = (await gateway!.request('list')) as { mounts: { mountId: string; root: string }[] }
    expect(list.mounts.filter(mount => mount.root === realpathSync(directory.root))).toHaveLength(1)
    // Unmount by root, then the mount is gone from `list`.
    await gateway!.request('unmount', { root: directory.root })
    const after = (await gateway!.request('list')) as { mounts: { mountId: string }[] }
    expect(after.mounts.some(mount => mount.mountId === first.mountId)).toBe(false)
  } finally {
    directory.dispose()
  }
})

test('2c. a directory that does not exist is refused with ENOTDIR', async () => {
  const directory = fixture()
  try {
    await expect(gateway!.mount(join(directory.root, 'missing'))).rejects.toThrow(/ENOTDIR/)
  } finally {
    directory.dispose()
  }
})

test('2d. a page on one port never sees the other directory’s writes', async ({ browser }) => {
  const first = fixture({ 'a.md': '# A\n' })
  const second = fixture({ 'b.md': '# B\n' })
  try {
    const a = await gateway!.mount(first.root)
    const b = await gateway!.mount(second.root)
    writeFileSync(join(first.root, 'a.md'), '# A changed\n')
    writeFileSync(join(second.root, 'b.md'), '# B changed\n')
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    try {
      await pageA.goto(a.url)
      await pageB.goto(b.url)
      await waitForPage(pageA)
      await waitForPage(pageB)
      const readA = await pageA.evaluate(async () => {
        const fs = (globalThis as unknown as { __diorama_page__: { getKernel(): { mount: { fs: { readText(p: string): Promise<string> } } } } }).__diorama_page__.getKernel().mount.fs
        return fs.readText('a.md')
      })
      const readB = await pageB.evaluate(async () => {
        const fs = (globalThis as unknown as { __diorama_page__: { getKernel(): { mount: { fs: { readText(p: string): Promise<string> } } } } }).__diorama_page__.getKernel().mount.fs
        return fs.readText('b.md')
      })
      expect(readA).toContain('A changed')
      expect(readB).toContain('B changed')
      // The RPC of A does not expose B's files.
      const cross = await pageA.evaluate(async () => {
        const fs = (globalThis as unknown as { __diorama_page__: { getKernel(): { mount: { fs: { readText(p: string): Promise<string> } } } } }).__diorama_page__.getKernel().mount.fs
        try {
          await fs.readText('b.md')
          return 'read'
        } catch (error) {
          return (error as { code?: string }).code ?? 'error'
        }
      })
      expect(cross).toBe('ENOENT')
    } finally {
      await pageA.close()
      await pageB.close()
    }
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('2e. unmounting one directory leaves the other serving (fork contexts are independent)', async ({ browser }) => {
  const first = fixture({ 'a.md': '# A\n' })
  const second = fixture({ 'b.md': '# B\n' })
  const pageB = await browser.newPage()
  try {
    const a = await gateway!.mount(first.root)
    const b = await gateway!.mount(second.root)
    await pageB.goto(b.url)
    await waitForPage(pageB)
    await pageB.getByTestId('file-tree').locator('[data-path="b.md"]').click()
    await expect(pageB.getByTestId('markdown')).toContainText('B', { timeout: 10_000 })

    // Unmount A: its port stops answering, B keeps working without a reload.
    await gateway!.request('unmount', { mountId: a.mountId })
    await expect.poll(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${a.port}/plugin.json`)).status
      } catch {
        return 'closed'
      }
    }, { timeout: 5_000 }).toBe('closed')
    const stillThere = await pageB.evaluate(async () => {
      const fs = (globalThis as unknown as { __diorama_page__: { getKernel(): { mount: { fs: { readText(p: string): Promise<string> } } } } }).__diorama_page__.getKernel().mount.fs
      return fs.readText('b.md')
    })
    expect(stillThere).toContain('B')
    expect(pageB.isClosed()).toBe(false)

    // The plugin graph of the gateway survived: mounting A again boots a new
    // fork without restarting the process (same pid in `ping`).
    const before = (await gateway!.request('ping')) as { pid: number }
    const again = await gateway!.mount(first.root)
    expect(again.created).toBe(true)
    expect(again.mountId).not.toBe(a.mountId)
    expect(((await gateway!.request('ping')) as { pid: number }).pid).toBe(before.pid)
    const pageA = await browser.newPage()
    try {
      await pageA.goto(again.url)
      await waitForPage(pageA)
      await expect(pageA.getByTestId('file-tree')).toContainText('a.md')
    } finally {
      await pageA.close()
    }
  } finally {
    await pageB.close()
    first.dispose()
    second.dispose()
  }
})

test('2f. two pages on one mount share the server’s directory watcher', async ({ browser }) => {
  const directory = fixture({ 'shared.txt': 'first\n' })
  try {
    const mount = await gateway!.mount(directory.root)
    const one = await browser.newPage()
    const two = await browser.newPage()
    try {
      await one.goto(mount.url)
      await two.goto(mount.url)
      await waitForPage(one)
      await waitForPage(two)
      // Both pages subscribe to the root directory (the tree does this on
      // open); the server must watch it once, and a change must reach both.
      writeFileSync(join(directory.root, 'shared.txt'), 'second\n')
      const read = async (page: typeof one): Promise<string> =>
        page.evaluate(async () => {
          const fs = (globalThis as unknown as { __diorama_page__: { getKernel(): { mount: { fs: { readText(p: string): Promise<string> } } } } }).__diorama_page__.getKernel().mount.fs
          return fs.readText('shared.txt')
        })
      await expect.poll(() => read(one), { timeout: 10_000 }).toContain('second')
      await expect.poll(() => read(two), { timeout: 10_000 }).toContain('second')
      // A second edit still reaches both (the shared watcher survived the first).
      writeFileSync(join(directory.root, 'shared.txt'), 'third\n')
      await expect.poll(() => read(one), { timeout: 10_000 }).toContain('third')
      await expect.poll(() => read(two), { timeout: 10_000 }).toContain('third')
    } finally {
      await one.close()
      await two.close()
    }
  } finally {
    directory.dispose()
  }
})
