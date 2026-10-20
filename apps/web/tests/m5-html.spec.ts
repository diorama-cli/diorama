import { expect, test } from '@playwright/test'
import { fixture, startDiorama, type Diorama, type Fixture } from './support.ts'

/**
 * HTML (contract.md §5.1): `.html` / `.htm` belong to the `html` renderer.
 *
 * The preview keeps the page's own CSS — inline, `style=`, external — and its
 * remote images. Page scripts run only after the reader confirms, per file:
 * the bar offers "run scripts", and that stage is `allow-scripts` **without**
 * `allow-same-origin`, so a page can run but never reach the viewer.
 */
let directory: Fixture
let server: Diorama

const pageOf = (body: string, head = ''): Uint8Array =>
  new TextEncoder().encode(`<!doctype html>\n<html><head><title>Fixture</title>${head}</head><body>${body}</body></html>`)

const STYLED = pageOf(
  '<h1 id="headline">Hello page</h1>' +
    '<p id="inline" style="color: rgb(0, 128, 0)">inline style</p>' +
    '<p id="handler" onclick="window.__clicked = 1">body text</p>' +
    // The script proves itself through the page it draws, and tries to escape.
  '<script>document.body.dataset.ran = "yes"; try { parent.__escaped = true } catch (e) {}</script>',
  '<style>h1 { color: rgb(1, 2, 3); } body { background: rgb(250, 250, 250); }</style>',
)

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

test('html: the preview keeps the page CSS and does not run its scripts', async ({ page: browser }) => {
  directory = fixture({}, { 'site/styled.html': STYLED })
  server = await startDiorama(directory.root)
  await browser.goto(`${server.url}~/site/styled.html`)

  await expect(browser.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]'))
    .toHaveAttribute('data-renderer', 'html:renderer')
  const frame = browser.getByTestId('html-frame')
  await expect(frame).toBeVisible()
  await expect(browser.getByTestId('html')).toHaveAttribute('data-mode', 'preview')
  await expect(browser.getByTestId('html')).toHaveAttribute('data-stage', 'styles')
  // Before confirmation there is no script sandbox at all.
  expect(await frame.getAttribute('sandbox')).toBe('allow-same-origin')

  const inner = browser.frameLocator('[data-testid="html-frame"]')
  await expect(inner.locator('h1#headline')).toHaveText('Hello page')
  // The page's own stylesheet and its inline style survived the sanitiser and
  // the frame policy: this is the page's look, not a stripped document.
  expect(await inner.locator('h1#headline').evaluate(node => getComputedStyle(node).color)).toBe('rgb(1, 2, 3)')
  expect(await inner.locator('#inline').evaluate(node => getComputedStyle(node).color)).toBe('rgb(0, 128, 0)')
  expect(await inner.locator('style').count()).toBe(1)

  // The reader is told the page has a script, and nothing ran yet.
  const notice = browser.getByTestId('html-script-notice')
  await expect(notice).toContainText('未执行')
  // Scripts did not run: the body carries no marker from the page's script.
  expect(await inner.locator('body').getAttribute('data-ran')).toBeNull()
  expect(await browser.evaluate(() => (window as unknown as { __escaped__?: boolean }).__escaped__ === true)).toBe(false)
})

test('html: confirming runs the page scripts in a sandbox that cannot reach the viewer', async ({ page: browser }) => {
  directory = fixture({}, { 'site/styled.html': STYLED })
  server = await startDiorama(directory.root)
  await browser.goto(`${server.url}~/site/styled.html`)

  await browser.getByTestId('html-script-run').click()
  const frame = browser.getByTestId('html-frame')
  await expect(browser.getByTestId('html')).toHaveAttribute('data-stage', 'scripts')
  // The confirmed stage is scripts, and never same-origin.
  const sandbox = (await frame.getAttribute('sandbox')) ?? ''
  expect(sandbox).toContain('allow-scripts')
  expect(sandbox).not.toContain('allow-same-origin')

  const inner = browser.frameLocator('[data-testid="html-frame"]')
  // The page ran: its script marked the body it draws (visible through the
  // frame locator, which is Playwright's own channel, not page JS).
  await expect(inner.locator('body')).toHaveAttribute('data-ran', 'yes')
  // The viewer cannot read into it either: no same-origin, by construction.
  await expect.poll(() => frame.evaluate((node: HTMLIFrameElement) => {
    try {
      return (node.contentWindow as unknown as { __ran?: boolean }).__ran === true
    } catch (error) {
      return String(error).includes('cross-origin')
    }
  })).toBe(true)
  // ... and it could not reach this page (no same-origin: `parent` is inaccessible).
  expect(await browser.evaluate(() => (window as unknown as { __escaped__?: boolean }).__escaped__ === true)).toBe(false)
  // Styles stay in the scripts stage.
  expect(await inner.locator('h1#headline').evaluate(node => getComputedStyle(node).color)).toBe('rgb(1, 2, 3)')

  // The reader can take it back, and stopping means a fresh, script-free frame.
  await browser.getByTestId('html-script-revoke').click()
  await expect(browser.getByTestId('html')).toHaveAttribute('data-stage', 'styles')
  expect(await browser.getByTestId('html-frame').getAttribute('sandbox')).toBe('allow-same-origin')
})

test('html: a page without scripts gets no confirmation bar', async ({ page: browser }) => {
  directory = fixture({}, { 'site/plain.html': pageOf('<p id="p" style="color: rgb(9, 9, 9)">plain</p>') })
  server = await startDiorama(directory.root)
  await browser.goto(`${server.url}~/site/plain.html`)
  await expect(browser.getByTestId('html-frame')).toBeVisible()
  await expect(browser.getByTestId('html-script-notice')).toHaveCount(0)
  expect(await browser.frameLocator('[data-testid="html-frame"]').locator('#p')
    .evaluate(node => getComputedStyle(node).color)).toBe('rgb(9, 9, 9)')
})

test('html: the source view shows the file text, escaped', async ({ page: browser }) => {
  directory = fixture({}, {
    'site/src.html': new TextEncoder().encode(
      '<div id="one"><em>one</em></div>\n<p onmouseover="window.__hovered = 1">two</p>\n',
    ),
  })
  server = await startDiorama(directory.root)
  await browser.goto(`${server.url}~/site/src.html`)

  await browser.getByTestId('html-mode-source').click()
  await expect(browser.getByTestId('html')).toHaveAttribute('data-mode', 'source')
  const source = browser.getByTestId('html-source')
  await expect(source).toContainText('<p onmouseover="window.__hovered = 1">two</p>')
  expect(await browser.locator('.diorama-html__source strong, .diorama-html__source p').count()).toBe(0)
  await expect(browser.getByTestId('html-frame')).toHaveCount(0)

  await browser.getByTestId('html-mode-preview').click()
  await expect(browser.getByTestId('html-frame')).toBeVisible()
})

test('html: another file in the same tab starts in preview, unconfirmed', async ({ page: browser }) => {
  directory = fixture({}, {
    'site/one.html': STYLED,
    'site/two.html': pageOf('<p>two</p>'),
  })
  server = await startDiorama(directory.root)
  await browser.goto(`${server.url}~/site/one.html`)
  await browser.getByTestId('html-script-run').click()
  await expect(browser.getByTestId('html')).toHaveAttribute('data-stage', 'scripts')

  await browser.evaluate(() => {
    history.pushState({}, '', location.pathname.replace('site/one.html', 'site/two.html'))
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  // Hidden seats stay mounted (every tab keeps one): scope to the one on screen.
  const shown = browser.getByTestId('tabs-content').filter({ visible: true })
  await expect(shown.getByTestId('html')).toHaveAttribute('data-mode', 'preview')
  await expect(shown.getByTestId('html')).toHaveAttribute('data-stage', 'styles')
  await expect(browser.getByTestId('tabs-content').filter({ visible: true }).getByTestId('html-frame')
    .contentFrame().locator('p')).toHaveText('two')
})

test('html: without the html piece a page falls back to plaintext source', async ({ page: browser }) => {
  directory = fixture({}, { 'site/plain.html': pageOf('<p>plain</p>') })
  server = await startDiorama(directory.root, [
    '--plugins',
    'slots,layout,file-tree,tabs,renderer-registry,plaintext,markdown,code',
  ])
  await browser.goto(`${server.url}~/site/plain.html`)
  await expect(browser.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="renderer"]'))
    .toHaveAttribute('data-renderer', 'plaintext:fallback')
})
