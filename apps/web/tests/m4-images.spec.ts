import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage, type Diorama, type Fixture } from './support.ts'

/**
 * Images (contract.md §5.1 v0.6): the kernel pre-reads text only, so the image
 * renderer fetches bytes itself after a `stat`, and refuses to ask for a file
 * larger than `MAX_BINARY_BYTES`. Matching is the `image/*` mime wildcard.
 */
let directory: Fixture
let server: Diorama

/** A 1×1 PNG, so the browser decodes something real. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

test('images: a png and an svg render through <img> with a blob URL', async ({ page }) => {
  directory = fixture({}, { 'assets/dot.png': new Uint8Array(PNG_1X1) })
  server = await startDiorama(directory.root)
  await page.goto(server.url)

  await page.locator('[data-path="assets"]').click()
  await page.locator('[data-path="assets/dot.png"]').click()
  const image = page.getByTestId('image-img')
  await expect(image).toBeVisible()
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]'))
    .toHaveAttribute('data-renderer', 'image:renderer')
  // The picture was actually decoded by the browser, not just linked.
  expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1)
  expect(await image.getAttribute('src')).toMatch(/^blob:/)
  await expect(page.getByTestId('image')).toContainText('image/png')
})

test('images: svg is shown as an image, not inlined into the page', async ({ page }) => {
  directory = fixture({
    'assets/logo.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
  })
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await page.locator('[data-path="assets"]').click()
  await page.locator('[data-path="assets/logo.svg"]').click()
  const image = page.getByTestId('image-img')
  await expect(image).toBeVisible()
  // An <img> shows the SVG; its DOM is never part of the page. (The header's
  // file-type glyph is an <svg> of our own, so the assertion names the file's
  // own markup — the fixture's `<rect>` — rather than "any svg in the pane".)
  expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(4)
  expect(await page.locator('.diorama-image svg rect').count()).toBe(0)
})

test('images: a file over the byte limit says so and is never requested', async ({ page }) => {
  // `assets/` exists so the tree has the node; the big file is added below.
  directory = fixture({ 'assets/keep.txt': 'x\n' })
  // 33 MiB of zeros: over MAX_BINARY_BYTES (32 MiB). Written after the fixture
  // so the directory does not pay for two copies.
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await waitForPage(page)
  // Record every readBytes the page makes from now on.
  await page.evaluate(() => {
    const bridge = (window as unknown as {
      __diorama_page__: { getKernel(): { mount: { fs: { readBytes(p: string): Promise<Uint8Array> } } } }
    }).__diorama_page__
    const fs = bridge.getKernel().mount.fs
    const original = fs.readBytes.bind(fs)
    ;(window as unknown as { __reads__: string[] }).__reads__ = []
    fs.readBytes = async (path: string) => {
      ;(window as unknown as { __reads__: string[] }).__reads__.push(path)
      return await original(path)
    }
  })
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(join(directory.root, 'assets', 'huge.png'), new Uint8Array(33 * 1024 * 1024))

  await page.locator('[data-path="assets"]').click()
  await page.locator('[data-path="assets/huge.png"]').click()
  const placeholder = page.getByTestId('image-too-large')
  await expect(placeholder).toBeVisible()
  await expect(placeholder).toContainText('33.0 MiB')
  const reads = await page.evaluate(() => (window as unknown as { __reads__: string[] }).__reads__)
  expect(reads).not.toContain('assets/huge.png')
})

test('images: a non-image binary still falls back to plaintext', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await page.locator('[data-path="blob.bin"]').click()
  // The wildcard only claims image/*: an unknown binary keeps the fallback.
  await expect(page.getByTestId('plaintext-binary')).toContainText('二进制文件')
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]'))
    .toHaveAttribute('data-renderer', 'plaintext:fallback')
})
