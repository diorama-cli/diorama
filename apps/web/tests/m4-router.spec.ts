import { expect, test } from '@playwright/test'
import { fixture, startDiorama } from './support.ts'

/**
 * `ctx.router` over the real page (docs/m4/spec.md S3, contract.md §3.8): a
 * path URL opens a file, a refresh keeps it, closing returns to the root, and
 * a path that leaves the mount opens nothing.
 */

test('route: a /~/ path opens the file, a refresh keeps it, closing returns to the root', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/docs/notes.md`)
    // A deep link shows that file, with exactly one tab.
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)
    await expect(page.locator('.diorama-tabs__strip [role="tab"] .diorama-tabs__label')).toHaveText('notes.md')
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('.diorama-markdown h1')).toHaveText('Notes')

    // A refresh restores the same file (the tab set is not persisted: one tab).
    await page.reload()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)
    await expect(page.locator('.diorama-tabs__strip [role="tab"] .diorama-tabs__label')).toHaveText('notes.md')
    expect(new URL(page.url()).pathname).toBe('/~/docs/notes.md')

    // Opening a file through the tree writes the URL.
    await page.getByTestId('file-tree').locator('[data-path="README.md"]').click()
    await expect(page).toHaveURL(/\/~\/README\.md$/)

    // Closing the active tab hands over to the other one, and the URL follows.
    await page.getByTestId('active-tab').getByTestId('tab-close').click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"] .diorama-tabs__label')).toHaveText('notes.md')
    await expect(page).toHaveURL(/\/~\/docs\/notes\.md$/)
    // Closing the last tab returns to the root.
    await page.getByTestId('active-tab').getByTestId('tab-close').click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('tabs-empty')).toBeVisible()

    // Back walks the same history the page wrote (each open/close is an entry):
    // one step back is the first closed tab, two is the file opened before it.
    await page.goBack()
    await expect(page.locator('.diorama-tabs__strip [role="tab"] .diorama-tabs__label')).toHaveText('notes.md')
    await expect(page).toHaveURL(/\/~\/docs\/notes\.md$/)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('route: a path that leaves the mount opens nothing', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/%2e%2e/%2e%2e/etc/passwd`)
    await expect(page.getByTestId('tabs-empty')).toBeVisible()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(0)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
