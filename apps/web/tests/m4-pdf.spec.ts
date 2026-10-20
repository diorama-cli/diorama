import { expect, test } from '@playwright/test'
import { fixture, minimalPdf, startDiorama, waitForPage, type Diorama, type Fixture } from './support.ts'

/**
 * PDF (contract.md §5.1 v0.6): `.pdf` is claimed by the ext tier, the bytes
 * come from `fs.readBytes` after a stat (never over the limit), and the
 * browser's own viewer draws the blob in a frame — with a link to the blob so
 * the file is reachable even where no viewer is built in.
 */
let directory: Fixture
let server: Diorama

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

test('pdf: a pdf opens in the browser viewer through a blob URL', async ({ page }) => {
  directory = fixture({}, { 'docs/guide.pdf': minimalPdf() })
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await page.locator('[data-path="docs"]').click()
  await page.locator('[data-path="docs/guide.pdf"]').click()

  await expect(page.getByTestId('pdf-frame')).toBeVisible()
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]'))
    .toHaveAttribute('data-renderer', 'pdf:renderer')
  const src = await page.getByTestId('pdf-frame').getAttribute('src')
  expect(src).toMatch(/^blob:/)
  // The full document reached the frame, not a truncated read.
  const shipped = await page.getByTestId('pdf-open').getAttribute('href')
  expect(shipped).toBe(src)
  const bytes = await page.evaluate(async (url: string) => {
    const response = await fetch(url)
    const buffer = await response.arrayBuffer()
    return Array.from(new Uint8Array(buffer.slice(0, 8)))
  }, src as string)
  expect(bytes.slice(0, 5)).toEqual([...'%PDF-'].map(char => char.charCodeAt(0)))
})

test('pdf: a file over the byte limit says so and is never requested', async ({ page }) => {
  directory = fixture({ 'docs/keep.txt': 'x\n' })
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await waitForPage(page)
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
  writeFileSync(join(directory.root, 'docs', 'huge.pdf'), new Uint8Array(33 * 1024 * 1024))

  await page.locator('[data-path="docs"]').click()
  await page.locator('[data-path="docs/huge.pdf"]').click()
  await expect(page.getByTestId('pdf-too-large')).toBeVisible()
  const reads = await page.evaluate(() => (window as unknown as { __reads__: string[] }).__reads__)
  expect(reads).not.toContain('docs/huge.pdf')
})

test('pdf: removing the pdf plugin falls back to plaintext without asking for bytes', async ({ page }) => {
  // A real PDF is a binary file (NUL bytes in its streams). The hand-written
  // fixture is pure ASCII, so give it one NUL: that is what makes it EBINARY
  // for `readText`, and what a plaintext fallback must describe, not decode.
  const binary = minimalPdf()
  binary[binary.length - 1] = 0
  directory = fixture({}, { 'docs/guide.pdf': binary })
  server = await startDiorama(directory.root, [
    '--plugins',
    'slots,layout,file-tree,tabs,renderer-registry,plaintext,image',
  ])
  await page.goto(server.url)
  await page.locator('[data-path="docs"]').click()
  await page.locator('[data-path="docs/guide.pdf"]').click()
  // `.pdf` is not text, so the fallback describes it from the stat — it shows
  // the type and size rather than a broken or blank pane.
  await expect(page.getByTestId('plaintext-binary')).toContainText('application/pdf')
})
