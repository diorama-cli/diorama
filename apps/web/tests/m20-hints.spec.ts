import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Shortcut hints (contract.md §3.7, v0.16):
 *
 * - holding a modifier (⌘ / Ctrl, or Option / Alt) shows the **key** shortcuts
 *   — the tab picks — as floating labels; releasing it takes them away;
 * - a hint is a floating label: it changes neither the control's size nor the
 *   position of anything around it (the tab strip keeps its geometry);
 * - only the key bindings are shown: a tab's ✕ has no chip, the fold button
 *   has none either (those live in the shortcut sheet);
 * - ⌘1 … ⌘9 jump to the tab at that position (the editor's chord), and middle
 *   click closes a tab.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Every hint chip on the page, as `data-keys` (the canonical binding). */
async function hintKeys(page: Page): Promise<string[]> {
  return await page.getByTestId('key-hint').evaluateAll(elements => elements.map(element => element.getAttribute('data-keys') ?? ''))
}

/** The chips inside one control. */
async function hintsIn(page: Page, selector: string): Promise<string[]> {
  return await page.locator(`${selector} [data-testid="key-hint"]`).evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-keys') ?? ''),
  )
}

/** The tab strip's geometry, as the browser lays it out. */
async function stripGeometry(page: Page): Promise<number[]> {
  return await page.locator('.diorama-tabs__strip [role="tab"]').evaluateAll(elements =>
    elements.map(element => Math.round(element.getBoundingClientRect().width)),
  )
}

test('hints: holding the modifier shows the tab keys, and the strip does not move', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    for (const file of ['README.md', 'LICENSE']) await tree.locator(`[data-path="${file}"]`).click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)

    // Nothing is shown until a modifier is held.
    expect(await hintKeys(page)).toEqual([])
    const before = await stripGeometry(page)

    await page.keyboard.down(MOD)
    // Each tab answers ⌘1 / ⌘2 …
    expect(await hintsIn(page, '.diorama-tabs__strip')).toEqual(['mod+1', 'mod+2'])
    // … and **only** the tab keys: the ✕ of a tab has no chip.
    expect(await hintsIn(page, '[data-testid="tab-close"]')).toEqual([])
    // A hint floats: the tabs keep their exact widths while it is up.
    expect(await stripGeometry(page)).toEqual(before)

    await page.keyboard.up(MOD)
    await expect.poll(() => hintKeys(page)).toEqual([])
    expect(await stripGeometry(page)).toEqual(before)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('hints: the chip prints the registry label, and Option alone shows them too', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('file-tree').locator('[data-path="README.md"]').click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)

    // The registry's own label for the binding: the page and the shortcut
    // sheet read the same table (contract.md §3.7).
    const label = await page.evaluate(() => {
      const kernel = (window as unknown as {
        __diorama_page__: { getKernel(): { ctx: { commands: { getSnapshot(): { bindings: { keys: string; label: string; command: string }[] } } } } }
      }).__diorama_page__.getKernel()
      const bindings = kernel.ctx.commands.getSnapshot().bindings
      return bindings.find(binding => binding.command === 'tabs.select:1')?.label ?? null
    })
    expect(label).not.toBeNull()

    await page.keyboard.down(MOD)
    const chip = page.locator('.diorama-tabs__strip [data-keys="mod+1"]')
    await expect(chip).toHaveText(label as string)
    // Decoration only: the tab's accessible name is still the file's.
    await expect(chip).toHaveAttribute('aria-hidden', 'true')
    await page.keyboard.up(MOD)

    // Option / Alt on its own is the other hold that reveals the hints: the
    // bindings use both families, so "hold a modifier and look" answers for
    // whichever one the reader reached for.
    await page.keyboard.down('Alt')
    await expect(page.locator('.diorama-tabs__strip [data-keys="mod+1"]')).toBeVisible()
    await page.keyboard.up('Alt')
    await expect.poll(() => hintKeys(page)).toEqual([])
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('hints: the sidebar shows its view keys, and the fold button shows none', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await expect(page.getByTestId('sidebar-view').first()).toBeVisible()

    await page.keyboard.down(MOD)
    // The fixture is not a git repository, so only the two views that always
    // register are there: files (⌘⌥1) and search (⌘⌥4).
    const views = await hintsIn(page, '[data-testid="sidebar-switcher"]')
    expect(views).toEqual(expect.arrayContaining(['mod+alt+1', 'mod+alt+4']))
    // Only the key shortcuts: folding the column is not one of them.
    expect(await hintsIn(page, '[data-testid="sidebar-fold"]')).toEqual([])
    await page.keyboard.up(MOD)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('hints: mod+1 … mod+9 jump to the tab at that position', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    // 'docs' expands the directory; the nested file is a row of its own.
    for (const file of ['README.md', 'docs', 'docs/notes.md', 'LICENSE']) await tree.locator(`[data-path="${file}"]`).click()
    const active = async (): Promise<string | null> => await page.getByTestId('active-tab').getAttribute('title')
    expect(await active()).toBe('LICENSE')

    await page.keyboard.press(`${MOD}+1`)
    expect(await active()).toBe('README.md')
    await page.keyboard.press(`${MOD}+2`)
    expect(await active()).toBe('docs/notes.md')
    await page.keyboard.press(`${MOD}+3`)
    expect(await active()).toBe('LICENSE')

    // A slot with no tab behind it is not executable: ⌘5 is a no-op, not a
    // jump to some other tab.
    await page.keyboard.press(`${MOD}+5`)
    expect(await active()).toBe('LICENSE')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('tabs: a middle click closes the tab it lands on', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    for (const file of ['README.md', 'LICENSE']) await tree.locator(`[data-path="${file}"]`).click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)

    // The first tab (README.md) is closed by the middle button, whichever tab
    // is active.
    await page.locator('.diorama-tabs__strip [role="tab"]').first().click({ button: 'middle' })
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)
    expect(await page.getByTestId('active-tab').getAttribute('title')).toBe('LICENSE')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
