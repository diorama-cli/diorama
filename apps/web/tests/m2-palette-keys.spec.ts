import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

test('8c. palette rows show the shortcut that runs each command', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('file-tree').locator('[data-path="README.md"]').click()
    const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette')).toBeVisible()

    // Rows with a binding print the key the registry holds — the same `label`
    // the shortcut sheet prints (contract.md §3.7, v0.17).
    const closeKey = page.locator('[data-command="tabs.close"] [data-testid="palette-keys"] kbd')
    await expect(closeKey).toHaveText(process.platform === 'darwin' ? '⌘W' : 'Ctrl+W')
    await expect(page.locator('[data-command="sidebar.showFiles"] [data-testid="palette-keys"] kbd')).toHaveText(
      process.platform === 'darwin' ? '⌘⌥1' : 'Ctrl+Alt+1',
    )
    // The chip is one line of its row: right-aligned, before the command id.
    await expect(page.locator('[data-command="tabs.close"] .diorama-palette__key')).toBeVisible()

    // A row whose command has no binding shows nothing, not an empty slot.
    const unbound = page.locator('[data-command="view.toggleAutoRefresh"]')
    await expect(unbound).toBeVisible()
    await expect(unbound.locator('[data-testid="palette-keys"]')).toHaveCount(0)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
