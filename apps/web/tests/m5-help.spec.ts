import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * The shortcut sheet (contract.md §3.7, §5, v0.7): a second `layout.overlay`
 * entry that lists every binding, dims the ones that cannot run right now, and
 * takes turns with the palette.
 *
 * `?` is Shift+/ on a US layout, and the kernel matches modifiers exactly, so
 * the test presses `Shift+Slash` — `press('?')` synthesises `key: '?'` with
 * `shiftKey: false`, which the binding must not accept (see bindings.ts).
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

test('1. ? opens the sheet, ? or Escape closes it', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await expect(page.getByTestId('help')).toHaveCount(0)

    await page.keyboard.press('Shift+Slash')
    const sheet = page.getByTestId('help')
    await expect(sheet).toBeVisible()
    // Every bound command is listed, with its key rendered for the platform.
    await expect(sheet.locator('[data-command="tabs.close"]')).toBeVisible()
    await expect(sheet.locator('[data-command="tree.focus"]')).toBeVisible()
    const closeKey = sheet.locator('[data-command="tabs.close"] kbd')
    await expect(closeKey).toHaveText(process.platform === 'darwin' ? '⌘W' : 'Ctrl+W')

    // The same key closes it (toggle), and so does Escape.
    await page.keyboard.press('Shift+Slash')
    await expect(page.getByTestId('help')).toHaveCount(0)

    await page.keyboard.press('Shift+Slash')
    await expect(page.getByTestId('help')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('help')).toHaveCount(0)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('2. unavailable shortcuts are dimmed, not hidden', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    // No tab is open: `tabs.close` cannot run, yet the sheet still lists it.
    await page.keyboard.press('Shift+Slash')
    const row = page.getByTestId('help').locator('[data-command="tabs.close"]')
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('data-available', 'false')
    // A command that is always available stays bright.
    await expect(page.getByTestId('help').locator('[data-command="palette.toggle"]')).toHaveAttribute('data-available', 'true')

    // Opening a file makes the tab commands runnable, and the sheet says so.
    await page.keyboard.press('Escape')
    await page.getByTestId('file-tree').locator('[data-path="README.md"]').click()
    await page.keyboard.press('Shift+Slash')
    await expect(page.getByTestId('help').locator('[data-command="tabs.close"]')).toHaveAttribute('data-available', 'true')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('3. the sheet and the palette take turns', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.keyboard.press('Shift+Slash')
    await expect(page.getByTestId('help')).toBeVisible()
    // mod+k opens the palette and closes the sheet: one surface at a time.
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette')).toBeVisible()
    // The palette's field takes focus on the next tick (its own effect): wait
    // for it, or Escape would arrive before the field that handles it exists.
    await expect(page.getByTestId('palette-input')).toBeFocused()
    await expect(page.getByTestId('help')).toHaveCount(0)
    // And back: `?` from the palette's field is a query character, so close the
    // palette first (Escape), then open the sheet.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('palette')).toHaveCount(0)
    await page.keyboard.press('Shift+Slash')
    await expect(page.getByTestId('help')).toBeVisible()
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('4. typing ? in the palette filters, it does not open the sheet', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette-input')).toBeFocused()
    await page.getByTestId('palette-input').fill('?')
    await expect(page.getByTestId('help')).toHaveCount(0)
    await expect(page.getByTestId('palette-empty')).toBeVisible()
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('5. without the help plugin, ? does nothing', async ({ page }) => {
  const directory = fixture()
  // The same plugin set the palette's own test uses: everything but `help`.
  const server = await startDiorama(directory.root, [
    '--plugins',
    'slots,layout,file-tree,tabs,renderer-registry,plaintext,markdown,code,palette',
  ])
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.keyboard.press('Shift+Slash')
    await expect(page.getByTestId('help')).toHaveCount(0)
    // The palette is still there: the sheet is an extra, not a replacement.
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette')).toBeVisible()
  } finally {
    await server.stop()
    directory.dispose()
  }
})
