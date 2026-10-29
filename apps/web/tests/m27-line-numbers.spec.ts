/**
 * Line numbers and "go to line" in a real browser (contract.md §3.11).
 *
 * What needs a browser: the gutter is drawn per row, `mod+p` filters by the
 * path half of `path:42` and the renderer scrolls to the line through the
 * reveal store. The parsing rules themselves are pinned by
 * `packages/ui/test/line-numbers.test.ts` (no DOM needed).
 */
import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** A file whose lines are easy to name: 1…40, one per line. */
function numbered(): Record<string, string> {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
  return { 'src/app.ts': `${lines.join('\n')}\n` }
}

/** The text renderer of the visible tab. */
function content(page: import('@playwright/test').Page) {
  return page.getByTestId('tabs-content').filter({ visible: true })
}

/** Open `src/app.ts` from the tree (the directory is collapsed at first). */
async function openApp(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-path="src"]').click()
  await page.locator('[data-path="src/app.ts"]').click()
  await expect(content(page).getByTestId('code-lines')).toBeVisible()
}

test('line numbers: the gutter is on by default and the header switches it', async ({ page }) => {
  const directory = fixture(numbered())
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await openApp(page)
    const pane = content(page)

    // On by default: one row per line, each with its number.
    await expect(pane.getByTestId('code-lines')).toHaveAttribute('data-line-numbers', 'on')
    await expect(pane.locator('.diorama-line__num')).toHaveCount(40)
    await expect(pane.locator('.diorama-line__num').nth(9)).toHaveText('10')

    // The header's button is a toggle, and it hides the numbers, not the text.
    const toggle = pane.getByTestId('code-line-numbers')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(pane.getByTestId('code-lines')).toHaveAttribute('data-line-numbers', 'off')
    await expect(pane.locator('.diorama-line__num').first()).toBeHidden()
    await expect(pane.getByText('line 1', { exact: true })).toBeVisible()

    // The choice is a preference: it survives a reload.
    await page.reload()
    await waitForPage(page)
    await expect(content(page).getByTestId('code-lines')).toHaveAttribute('data-line-numbers', 'off')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('go to line: mod+p takes path:42 and flashes that line', async ({ page }) => {
  const directory = fixture(numbered())
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.keyboard.press(`${MOD}+p`)
    const input = page.getByTestId('quick-open-input')
    await expect(input).toBeFocused()
    await input.fill('app.ts:30')
    // The file half filters; the line half is shown, not searched.
    await expect(page.getByTestId('quick-open-row')).toHaveCount(1)
    await page.keyboard.press('Enter')

    await expect(page).toHaveURL(/\/~\/src\/app\.ts$/)
    const pane = content(page)
    await expect(pane.locator('[data-testid="code-reveal"]')).toHaveAttribute('data-line', '30')
    await expect(pane.locator('[data-testid="code-reveal"]')).toHaveAttribute('data-flash', 'true')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('go to line: a range covers both ends, and :999 lands on the last line', async ({ page }) => {
  const directory = fixture(numbered())
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await openApp(page)

    // The palette's `:` mode works on the file being read.
    await page.keyboard.press('Shift+Semicolon')
    const input = page.getByTestId('palette-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(':')
    await input.fill(':10-12')
    await page.keyboard.press('Enter')
    const bands = content(page).locator('[data-testid="code-reveal"]')
    await expect(bands).toHaveCount(3)
    await expect(bands.first()).toHaveAttribute('data-line', '10')
    await expect(bands.last()).toHaveAttribute('data-line', '12')

    // Past the end: the last line, not an error and not a no-op.
    await page.keyboard.press('Shift+Semicolon')
    await page.getByTestId('palette-input').fill(':999')
    await page.keyboard.press('Enter')
    await expect(content(page).locator('[data-testid="code-reveal"]')).toHaveCount(1)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('go to line: the palette names the line it will jump to, and refuses with no file open', async ({ page }) => {
  const directory = fixture(numbered())
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    // No tab: the row says so instead of doing nothing.
    await page.keyboard.press(`${MOD}+k`)
    await page.getByTestId('palette-input').fill(':7')
    await expect(page.getByTestId('palette-goto-line-empty')).toContainText('没有打开的文件')
    await page.keyboard.press('Escape')

    await openApp(page)
    await page.keyboard.press(`${MOD}+k`)
    await page.getByTestId('palette-input').fill(':7')
    const row = page.getByTestId('palette-goto-line')
    await expect(row).toHaveAttribute('data-line', '7')
    await expect(row).toContainText('跳转到第 7 行')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
