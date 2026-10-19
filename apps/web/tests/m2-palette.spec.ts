import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * M2 S5 (docs/m2/spec.md §4 rows 8–9, contract.md §3.7): the palette is a
 * plugin over the kernel's command registry — and removing it leaves the
 * shortcuts working.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

test('8. mod+k opens the palette, filters and runs a command', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="README.md"]').click()
    await tree.locator('[data-path="LICENSE"]').click()
    await expect(page.getByTestId('palette')).toHaveCount(0)

    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette')).toBeVisible()
    await expect(page.getByTestId('palette-input')).toBeFocused()
    // Only executable commands are listed; the tab ones are available now.
    await expect(page.locator('[data-command="tabs.close"]')).toBeVisible()
    await expect(page.locator('[data-command="tabs.next"]')).toBeVisible()

    // Filter by title, then run with Enter.
    await page.getByTestId('palette-input').fill('关闭当前')
    await expect(page.locator('[role="option"]')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('palette')).toHaveCount(0)
    await expect(page.locator('[role="tab"]')).toHaveCount(1)

    // Escape closes without running anything. (Focus may be on a tab label
    // now; the palette's field takes it when it opens.)
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('palette')).toHaveCount(0)
    await expect(page.locator('[role="tab"]')).toHaveCount(1)

    // An empty result says so instead of showing a blank list.
    await page.keyboard.press(`${MOD}+k`)
    await page.getByTestId('palette-input').fill('zzzz-not-a-command')
    await expect(page.getByTestId('palette-empty')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('palette')).toHaveCount(0)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('8b. unavailable commands are not listed', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    // No tab is open: the tab commands' `when` says so.
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette')).toBeVisible()
    await expect(page.locator('[data-command="tabs.next"]')).toHaveCount(0)
    await expect(page.locator('[data-command="tabs.close"]')).toHaveCount(0)
    // Commands with no tab precondition are still listed (the palette itself).
    await expect(page.locator('[data-command="palette.toggle"]')).toBeVisible()
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('9. without the palette plugin the shortcuts still work', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root, ['--plugins', 'slots,layout,file-tree,tabs,renderer-registry,plaintext,markdown,code'])
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="README.md"]').click()
    await tree.locator('[data-path="LICENSE"]').click()
    await expect(page.locator('[role="tab"]')).toHaveCount(2)
    // mod+k does nothing (nothing binds it), but mod+alt+w still closes.
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette')).toHaveCount(0)
    await page.keyboard.press(`${MOD}+Alt+w`)
    await expect(page.locator('[role="tab"]')).toHaveCount(1)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
