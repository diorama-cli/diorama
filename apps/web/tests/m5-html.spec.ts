import { expect, test } from '@playwright/test'
import { fixture, startDiorama, type Diorama, type Fixture } from './support.ts'

/**
 * HTML (contract.md §5.1): `.html` / `.htm` belong to the `html` renderer, which
 * shows a sanitised preview in a sandboxed frame by default and the file's own
 * source on request. The renderer's header carries the switch (O8: no toolbar).
 *
 * The preview is *sanitised content laid out by the browser*, not the page's
 * own look: the sanitiser removes `<style>`/handlers and the frame's CSP
 * (`default-src 'none'; img-src data:; style-src 'none'`) blocks everything a
 * page might still smuggle in.
 */
let directory: Fixture
let server: Diorama

const PAGE_BYTES = new TextEncoder().encode([
  '<!doctype html>',
  '<html><head><title>Fixture</title>',
  '<style>h1 { color: rgb(1, 2, 3); }</style>',
  '</head><body>',
  '<h1 id="headline">Hello page</h1>',
  '<p onclick="window.__clicked = 1">body text</p>',
  '<script>window.__ran = true; parent.__escaped = true</script>',
  '</body></html>',
].join(''))

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

test('html: a page opens as a sanitised preview in a sandboxed frame', async ({ page }) => {
  directory = fixture({}, { 'site/index.html': PAGE_BYTES, 'site/about.htm': new TextEncoder().encode('<p>about</p>') })
  server = await startDiorama(directory.root)
  await page.goto(`${server.url}~/site/index.html`)

  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]'))
    .toHaveAttribute('data-renderer', 'html:renderer')
  const frame = page.getByTestId('html-frame')
  await expect(frame).toBeVisible()
  // The default is the preview, and the frame is told not to run anything.
  await expect(page.getByTestId('html')).toHaveAttribute('data-mode', 'preview')
  await expect(page.getByTestId('html-mode-preview')).toHaveAttribute('aria-pressed', 'true')
  const sandbox = await frame.getAttribute('sandbox')
  expect(sandbox ?? '').not.toContain('allow-scripts')

  const inner = page.frameLocator('[data-testid="html-frame"]')
  await expect(inner.locator('h1#headline')).toHaveText('Hello page')
  // The document's own stylesheet did not survive the sanitiser: the preview is
  // sanitised content on the browser's default layout, not the page's look.
  expect(await inner.locator('h1#headline').evaluate(node => getComputedStyle(node).color)).not.toBe('rgb(1, 2, 3)')
  expect(await inner.locator('style').count()).toBe(0)

  // No script ran — not in the frame, not through it.
  const ran = await page.evaluate(() => (window as unknown as { __escaped__?: boolean }).__escaped__ === true)
  expect(ran).toBe(false)
  expect(await frame.evaluate((node: HTMLIFrameElement) => {
    const inner = node.contentWindow as unknown as { __ran?: boolean }
    return inner?.__ran === true
  })).toBe(false)
  // The inline handler is gone too: clicking the paragraph does nothing.
  await inner.locator('p').click({ force: true })
  expect(await frame.evaluate((node: HTMLIFrameElement) => {
    const inner = node.contentWindow as unknown as { __clicked?: boolean }
    return inner?.__clicked === true
  })).toBe(false)
})

test('html: the source view shows the file text, escaped', async ({ page }) => {
  directory = fixture({}, {
    // The handler is what must stay literal text here, not become an attribute.
    'site/plain.html': new TextEncoder().encode(
      '<div id="one"><em>one</em></div>\n<p onmouseover="window.__hovered = 1">two</p>\n',
    ),
  })
  server = await startDiorama(directory.root)
  await page.goto(`${server.url}~/site/plain.html`)

  await page.getByTestId('html-mode-source').click()
  await expect(page.getByTestId('html')).toHaveAttribute('data-mode', 'source')
  await expect(page.getByTestId('html-mode-source')).toHaveAttribute('aria-pressed', 'true')
  const source = page.getByTestId('html-source')
  await expect(source).toContainText('<p onmouseover="window.__hovered = 1">two</p>')
  // The text is a text node, not markup: the page has no such element.
  expect(await page.locator('.diorama-html__source strong, .diorama-html__source p').count()).toBe(0)
  // And the frame is gone while the source is up.
  await expect(page.getByTestId('html-frame')).toHaveCount(0)

  await page.getByTestId('html-mode-preview').click()
  await expect(page.getByTestId('html-frame')).toBeVisible()
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]'))
    .toHaveAttribute('data-renderer', 'html:renderer')
})

test('html: another file in the same tab starts in preview again', async ({ page }) => {
  directory = fixture({}, {
    'site/plain.html': new TextEncoder().encode('<p>one</p>\n'),
    'site/second.html': new TextEncoder().encode('<p>two</p>\n'),
  })
  server = await startDiorama(directory.root)
  await page.goto(`${server.url}~/site/plain.html`)

  await page.getByTestId('html-mode-source').click()
  await expect(page.getByTestId('html')).toHaveAttribute('data-mode', 'source')

  // The deep link replaces the tab's file: same seat, different file.
  await page.evaluate(() => {
    history.pushState({}, '', location.pathname.replace('site/plain.html', 'site/second.html'))
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  // Hidden seats are not unmounted (every open tab keeps one): scope to the
  // one on screen.
  const shown = page.getByTestId('tabs-content').filter({ visible: true })
  await expect(shown.getByTestId('html')).toHaveAttribute('data-mode', 'preview')
  // Playwright's frame chain hangs off the page: reach the seat's frame the
  // same way the other cases do (one filter for the seat, one for the frame).
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('html-frame')
    .contentFrame().locator('p')).toHaveText('two')
})

test('html: without the html piece a page falls back to plaintext source', async ({ page }) => {
  directory = fixture({}, { 'site/plain.html': new TextEncoder().encode('<p>plain</p>\n') })
  server = await startDiorama(directory.root, [
    '--plugins',
    'slots,layout,file-tree,tabs,renderer-registry,plaintext,markdown,code',
  ])
  await page.goto(`${server.url}~/site/plain.html`)
  // `.html` is not claimed by `code` any more: the text shows through the
  // fallback, not through a second HTML renderer.
  await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]'))
    .toHaveAttribute('data-renderer', 'plaintext:fallback')
})
