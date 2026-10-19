import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { fixture, startDiorama } from './support.ts'

/**
 * M2 S3 (docs/m2/spec.md §4 rows 5–6, contract.md §3.4): many tabs — open,
 * switch, close — each with its own content seat and scroll position.
 */

const LONG = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n')

test('5. open, switch and close tabs', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="README.md"]').click()
    await tree.locator('[data-path="docs"]').click()
    await tree.locator('[data-path="docs/notes.md"]').click()
    await tree.locator('[data-path="LICENSE"]').click()
    // Wait on the tab itself, not a count: a count can pass on the old DOM.
    await expect(page.locator('[role="tab"][title="LICENSE"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[role="tab"]')).toHaveCount(3)
    await expect(page.getByTestId('tab')).toHaveCount(2)

    // Clicking a tab activates it; re-opening a file activates its tab (no dup).
    await page.locator('[role="tab"][title="README.md"] .diorama-tabs__label').click()
    await expect(page.locator('[role="tab"][title="README.md"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('.diorama-markdown h1')).toHaveText('Readme')
    await tree.locator('[data-path="LICENSE"]').click()
    await expect(page.locator('[role="tab"][title="LICENSE"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[role="tab"]')).toHaveCount(3)

    // Only the active tab's content is visible; the others stay mounted.
    await expect(page.getByTestId('tabs-content')).toHaveCount(3)
    const visible = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(visible).toHaveCount(1)
    await expect(visible.locator('[data-testid="plaintext"]')).toBeVisible()

    // Closing the active tab activates its right neighbour (LICENSE → none right → README).
    await page.getByTestId('active-tab').getByTestId('tab-close').click()
    await expect(page.getByTestId('active-tab')).toHaveAttribute('title', 'docs/notes.md')
    await expect(page.locator('[role="tab"]')).toHaveCount(2)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('6. each tab keeps its own scroll position', async ({ page }) => {
  const directory = fixture({ 'scroller.txt': LONG })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="scroller.txt"]').click()
    await expect(page.getByTestId('plaintext')).toBeVisible()
    // Scroll the first tab.
    await page.getByTestId('tabs-content').filter({ visible: true }).evaluate(element => {
      element.scrollTop = 1200
    })
    await tree.locator('[data-path="README.md"]').click()
    await expect(page.getByTestId('active-tab')).toHaveAttribute('title', 'README.md')
    await page.locator('[role="tab"][title="scroller.txt"] .diorama-tabs__label').click()
    const scrolled = await page.getByTestId('tabs-content').filter({ visible: true }).evaluate(element => element.scrollTop)
    expect(scrolled).toBeGreaterThan(1000)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('5b. a deleted file says so instead of showing stale text', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await page.getByTestId('file-tree').locator('[data-path="LICENSE"]').click()
    await expect(page.getByTestId('plaintext')).toBeVisible()
    const { rmSync } = await import('node:fs')
    rmSync(join(directory.root, 'LICENSE'))
    writeFileSync(join(directory.root, 'unrelated.txt'), 'x')
    // Close the tab first: `open` on an already-open path only activates it.
    await page.getByTestId('active-tab').getByTestId('tab-close').click()
    // Re-open by path through the page's own tabs service: the file is gone.
    await page.evaluate(() => {
      const bridge = (window as unknown as {
        __diorama_page__: { getKernel(): { ctx: { tabs: { open(file: unknown): unknown } } } }
      }).__diorama_page__
      const tabs = bridge.getKernel().ctx.tabs
      tabs.open({ path: 'LICENSE', name: 'LICENSE', kind: 'file', size: 1, mtime: 0 })
    })
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('renderer-read-error')).toContainText('ENOENT')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
