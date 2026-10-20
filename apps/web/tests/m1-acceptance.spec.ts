import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage, type Diorama, type Fixture, type PageMount } from './support.ts'

/**
 * M1 acceptance (docs/m1/spec.md §4): the kernel took shape — RPC replaced the
 * M0 HTTP transport, `.md` renders as HTML, `code` highlights, and removing a
 * renderer falls back instead of blanking.
 */
let directory: Fixture
let server: Diorama

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

/** 2. `.md` renders to HTML; no HTTP file API is left. */
test('2. markdown renders .md as HTML', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await page.locator('[data-path="README.md"]').click()
  await page.getByTestId('markdown').waitFor()
  const article = page.locator('.diorama-markdown')
  await expect(article.locator('h1')).toHaveCount(1)
  await expect(article.locator('ul li')).toHaveCount(2)
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]')).toHaveAttribute('data-renderer', 'markdown:renderer')

  // The M0 HTTP transport is gone (contract.md §4): only RPC reaches files.
  const response = await page.request.get(`${server.url}api/fs/list?path=`)
  expect(response.status()).toBe(404)
})

/** 3. Removing the markdown plugin falls back to plaintext. */
test('3. removing markdown falls back to plaintext', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root, [
    '--plugins',
    'slots,layout,file-tree,tabs,renderer-registry,plaintext,code',
  ])
  await page.goto(server.url)
  await page.locator('[data-path="README.md"]').click()
  await page.getByTestId('plaintext').waitFor()
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]')).toHaveAttribute('data-renderer', 'plaintext:fallback')
  await expect(page.getByTestId('markdown')).toHaveCount(0)
})

/** 4. `code` highlights source; anything unclaimed lands in plaintext. */
test('4. code highlights source and plaintext takes the rest', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await page.locator('[data-path="src"]').click()
  await page.locator('[data-path="src/app.js"]').click()
  await page.getByTestId('code').waitFor()
  await expect(page.getByTestId('code')).toHaveAttribute('data-language', 'javascript')
  expect(await page.locator('.diorama-code .hljs-keyword').count()).toBeGreaterThan(0)

  await page.locator('[data-path="LICENSE"]').click()
  await page.getByTestId('plaintext').waitFor()
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]')).toHaveAttribute('data-renderer', 'plaintext:fallback')
})

/**
 * 5. A binary file says so instead of showing mojibake. The kernel pre-reads
 * text only (contract §5.1 v0.6), so the fallback describes the file from the
 * `stat` it already has: content, size and mime — not an empty placeholder.
 */
test('5. binary files are described, not decoded', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await page.locator('[data-path="blob.bin"]').click()
  const placeholder = page.getByTestId('plaintext-binary')
  await expect(placeholder).toContainText('二进制文件')
  await expect(placeholder).toContainText('application/octet-stream')
  await expect(placeholder).toContainText('200 字节')
})

/** 6. The page reaches the mount through RPC: services, errors, bytes. */
test('6. mountCtx.fs is an RPC proxy', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await waitForPage(page)
  const result = await page.evaluate(async () => {
    const bridge = (window as unknown as {
      __diorama_page__?: { getKernel(): { mount: PageMount } | undefined }
    }).__diorama_page__
    const mount = bridge?.getKernel()?.mount
    if (mount === undefined) throw new Error('the page did not boot')
    const entries = await mount.fs.list('')
    const info = await mount.fs.stat('README.md')
    const bytes = await mount.fs.readBytes('blob.bin')
    let outside = ''
    try {
      await mount.fs.readText('../etc/passwd')
    } catch (error) {
      outside = String((error as { code?: string }).code)
    }
    let unknown = ''
    try {
      await mount.rpc.call('nope.method')
    } catch (error) {
      unknown = String((error as { code?: string }).code)
    }
    return {
      names: entries.map(entry => entry.name).sort(),
      kind: info.kind,
      size: info.size,
      bytes: bytes.length,
      outside,
      unknown,
    }
  })
  expect(result.names).toContain('README.md')
  expect(result.names).toContain('blob.bin')
  expect(result.kind).toBe('file')
  expect(result.size).toBeGreaterThan(0)
  expect(result.bytes).toBe(200)
  expect(result.outside).toBe('EOUTSIDE')
  expect(result.unknown).toBe('ESERVICE')
})

/** 8. A plugin whose required infrastructure is missing is refused loudly. */
test('8. a plugin that requires missing infrastructure is refused', async () => {
  directory = fixture()
  // `layout` requires `slots` (contract.md §1): dropping it is a load error
  // naming both plugins, not a half-booted page.
  await expect(
    startDiorama(directory.root, ['--plugins', 'layout,file-tree,tabs,renderer-registry']),
  ).rejects.toThrow(/plugin "layout": requires "slots"/)
})

/**
 * 9. Clicking through many files keeps the page responsive.
 *
 * Regression: the dispatcher re-ran its renderer choice on every render (its
 * effect depended on freshly-built objects), which re-rendered for ever and
 * froze the tab after a few clicks. Every file must open promptly and the page
 * must still answer afterwards.
 */
test('9. clicking through files does not freeze the page', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await page.locator('[data-path="docs"]').click()
  await page.locator('[data-path="src"]').click()
  const files = [
    'README.md',
    'docs/notes.md',
    'src/app.js',
    'README.md',
    'LICENSE',
    'blob.bin',
    'README.md',
    'src/app.js',
    'docs/notes.md',
    'blob.bin',
  ]
  for (const file of files) {
    const started = Date.now()
    await page.getByTestId('file-tree').locator(`[data-path="${file}"]`).click({ timeout: 5_000 })
    await expect(page.getByTestId('active-tab').locator('.diorama-tabs__label')).toHaveText(file.slice(file.lastIndexOf('/') + 1))
    expect(Date.now() - started, `${file} took too long to open`).toBeLessThan(4_000)
  }
  // Still responsive: the page answers and a further file opens.
  await page.getByTestId('file-tree').locator('[data-path="src/app.js"]').click({ timeout: 5_000 })
  await expect(page.getByTestId('active-tab').locator('.diorama-tabs__label')).toHaveText('app.js')
})
