import { expect, test } from '@playwright/test'
import { fixture, startDiorama, type Diorama, type Fixture } from './support.ts'

let directory: Fixture
let server: Diorama

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

/** M0 acceptance point 1: `diorama .` prints a URL and the page runs. */
test('1. diorama prints a URL and the page boots', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  await page.goto(server.url)
  await expect(page.locator('[data-layout]')).toHaveAttribute('data-layout', 'split')
  await expect(page.getByTestId('file-tree')).toBeVisible()
})

/** M0 acceptance point 4: the served directory is data, not code. */
test('4. switching the directory needs no code change', async ({ page }) => {
  const first = fixture({ 'only-in-a.txt': 'alpha' })
  const second = fixture({ 'only-in-b.txt': 'beta' })
  try {
    server = await startDiorama(first.root)
    const manifestA = await (await fetch(`${server.url}plugin.json`)).json()
    const listA = await (await fetch(`${server.url}api/fs/list?path=`)).json()
    await server.stop()
    server = await startDiorama(second.root)
    const manifestB = await (await fetch(`${server.url}plugin.json`)).json()
    const listB = await (await fetch(`${server.url}api/fs/list?path=`)).json()
    expect(manifestA.root).toBe(first.realRoot)
    expect(manifestB.root).toBe(second.realRoot)
    expect(listA.entries.map((entry: { name: string }) => entry.name)).toContain('only-in-a.txt')
    expect(listB.entries.map((entry: { name: string }) => entry.name)).toContain('only-in-b.txt')
    await page.goto(server.url)
    await expect(page.getByText('only-in-b.txt')).toBeVisible()
  } finally {
    first.dispose()
    second.dispose()
  }
})

/** M0 acceptance point 5: a plugin without `name` fails loudly and names itself. */
test('5. a plugin missing its name is reported and the rest still boot', async () => {
  directory = fixture()
  server = await startDiorama(directory.root, ['--break-plugin', 'plaintext:name'])
  await expect.poll(() => server.output()).toContain('does not declare a "name" export')
  await expect.poll(() => server.output()).toContain('missing name')
  const manifest = await (await fetch(`${server.url}plugin.json`)).json()
  expect(manifest.plugins.map((plugin: { id: string }) => plugin.id)).toContain('layout')
})

/** M0 acceptance point 2: without a renderer the page says so (never blank). */
test('2. removing plaintext shows "无可用渲染器" instead of a blank page', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root, ['--plugins', 'slots,layout,file-tree,tabs,renderer-registry'])
  await page.goto(server.url)
  await page.locator('[data-path="README.md"]').click()
  await expect(page.getByTestId('renderer-empty')).toHaveText('无可用渲染器')
})

/** M0 acceptance point 3: without file-tree only the right side remains. */
test('3. removing file-tree leaves only the right side', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root, ['--plugins', 'slots,layout,tabs,renderer-registry,plaintext'])
  await page.goto(server.url)
  await expect(page.locator('[data-layout]')).toHaveAttribute('data-layout', 'main-only')
  await expect(page.getByTestId('file-tree')).toHaveCount(0)
  await expect(page.locator('[data-slot="layout.main"]')).toHaveCount(1)
})
