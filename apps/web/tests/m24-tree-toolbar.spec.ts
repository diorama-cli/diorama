import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * The file view's toolbar (contract.md §35): one button that locates the file
 * being browsed — expand the way to it, scroll its row into view — without
 * opening, selecting or closing anything.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

test('tree toolbar: locates the file of the active tab, expanding the way to it', async ({ page }) => {
  const directory = fixture({ 'docs/guides/deep/readme.md': '# Deep\n' })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    const toolbar = page.getByTestId('file-tree-toolbar')
    const locate = page.getByTestId('file-tree-reveal')
    await expect(toolbar).toBeVisible()
    // Nothing is being browsed yet: there is nowhere to go, and the button says
    // so rather than disappearing (a control that comes and goes moves the strip).
    await expect(locate).toBeDisabled()

    // Open a file three directories down, then close every directory again.
    await tree.locator('[data-path="docs"]').click()
    await tree.locator('[data-path="docs/guides"]').click()
    await tree.locator('[data-path="docs/guides/deep"]').click()
    await tree.locator('[data-path="docs/guides/deep/readme.md"]').click()
    await expect(page.getByTestId('active-tab').locator('.diorama-tabs__label')).toHaveText('readme.md')
    await tree.locator('[data-path="docs"]').click()
    await expect(tree.locator('[data-path="docs/guides"]')).toHaveCount(0)

    // The button is available now, and it brings the row back — every directory
    // on the way is expanded, and the row is marked as the one that was found.
    await expect(locate).toBeEnabled()
    await locate.click()
    await expect(tree.locator('[data-path="docs"]')).toHaveAttribute('aria-expanded', 'true')
    await expect(tree.locator('[data-path="docs/guides"]')).toBeVisible()
    await expect(tree.locator('[data-path="docs/guides/deep/readme.md"]')).toHaveAttribute('data-located', 'true')

    // Locating is not navigating: the same tab is active, and no second tab was
    // opened (clicking a tree row would have opened/activated one).
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)
    await expect(page).toHaveURL(/\/~\/docs\/guides\/deep\/readme\.md$/)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('tree toolbar: the same action is a command (palette and keyboard)', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    // No tab: the command is not executable, so the palette does not list it.
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.locator('[data-command="tree.revealActive"]')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await tree.locator('[data-path="docs"]').click()
    await tree.locator('[data-path="docs/notes.md"]').click()
    await tree.locator('[data-path="docs"]').click()
    await expect(tree.locator('[data-path="docs/notes.md"]')).toHaveCount(0)

    // The key does the same thing as the button (contract.md §3.7).
    await page.keyboard.press(`${MOD}+Shift+L`)
    await expect(tree.locator('[data-path="docs/notes.md"]')).toHaveAttribute('data-located', 'true')

    // ...and the palette lists it now.
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.locator('[data-command="tree.revealActive"]')).toBeVisible()
  } finally {
    await server.stop()
    directory.dispose()
  }
})
