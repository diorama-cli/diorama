import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Folding the left column (docs/m18/spec.md, contract.md §5.2):
 *
 * - the fold button at the foot of the switcher folds the column down to the
 *   switcher — the icons stay, the panes go — and `mod+b` does the same;
 * - folding is a **preference**: a reload comes back folded;
 * - it is not a view choice: unfolding comes back to the view that was shown,
 *   and picking a view from the switcher unfolds the column;
 * - a folded column has no draggable edge (there is no width to drag).
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** The sidebar's width as the browser lays it out. */
async function sidebarWidth(page: Page): Promise<number> {
  return await page.getByTestId('sidebar-switcher').evaluate(element => {
    const column = element.closest('.diorama-layout__sidebar')
    return column === null ? -1 : Math.round(column.getBoundingClientRect().width)
  })
}

/** The frame's folded flag, as the page wrote it. */
async function folded(page: Page): Promise<string | null> {
  return await page.locator('[data-layout]').getAttribute('data-folded')
}

test('sidebar: the fold button folds the column to the switcher, and back', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const switcher = page.getByTestId('sidebar-switcher')
    const fold = page.getByTestId('sidebar-fold')
    await expect(fold).toBeVisible()
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    expect(await folded(page)).toBe('false')
    const open = await sidebarWidth(page)
    expect(open).toBeGreaterThan(200)

    await fold.click()
    // The column is the switcher's rail: the panes are gone, the icons are not.
    await expect(page.getByTestId('sidebar-panes')).toBeHidden()
    await expect(switcher).toBeVisible()
    await expect(page.getByTestId('sidebar-view').first()).toBeVisible()
    expect(await folded(page)).toBe('true')
    const rail = await sidebarWidth(page)
    expect(rail).toBeGreaterThan(0)
    expect(rail).toBeLessThan(60)
    // There is no width to drag while folded.
    await expect(page.getByTestId('sidebar-splitter')).toHaveCount(0)
    // The button is now the unfold button, and it is still reachable.
    await expect(fold).toHaveAttribute('aria-expanded', 'false')
    await expect(fold).toHaveAttribute('aria-label', '展开侧栏')

    await fold.click()
    await expect(page.getByTestId('sidebar-panes')).toBeVisible()
    expect(await folded(page)).toBe('false')
    expect(await sidebarWidth(page)).toBe(open)
    await expect(page.getByTestId('sidebar-splitter')).toBeVisible()
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('sidebar: mod+b folds and unfolds, and a folded column stays folded on reload', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await expect(page.getByTestId('sidebar-view').first()).toBeVisible()

    await page.keyboard.press(`${MOD}+b`)
    await expect(page.getByTestId('sidebar-panes')).toBeHidden()
    expect(await folded(page)).toBe('true')

    // A preference, not page state: a reload comes back folded, and the view
    // the reader had is still the one behind the panes.
    await page.reload()
    await waitForPage(page)
    await expect(page.getByTestId('sidebar-panes')).toBeHidden()
    expect(await folded(page)).toBe('true')
    await expect(page.getByTestId('sidebar-switcher').getByRole('tab', { name: '文件' })).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press(`${MOD}+b`)
    await expect(page.getByTestId('sidebar-panes')).toBeVisible()
    // Unfolding is remembered as well: the reload does not fold again.
    await page.reload()
    await waitForPage(page)
    expect(await folded(page)).toBe('false')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('sidebar: the active icon folds the column, another icon switches the view', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const switcher = page.getByTestId('sidebar-switcher')
    const files = switcher.getByRole('tab', { name: '文件' })
    const search = switcher.getByRole('tab', { name: '搜索' })
    await expect(files).toHaveAttribute('aria-selected', 'true')
    await expect(files).toHaveAttribute('title', '文件（再点收起侧栏）')

    // The icon that is already showing folds the column: that is the gesture
    // the reader means by "click the left-hand icon" (contract.md §5.2).
    await files.click()
    await expect(page.getByTestId('sidebar-panes')).toBeHidden()
    expect(await folded(page)).toBe('true')
    await expect(files).toHaveAttribute('title', '文件（点击展开侧栏）')

    // On a folded column the icons are the only thing there: pressing another
    // one switches to that view **and** unfolds (it must not change a pane
    // nobody can see).
    await search.click()
    await expect(page.getByTestId('sidebar-panes')).toBeVisible()
    expect(await folded(page)).toBe('false')
    await expect(search).toHaveAttribute('aria-selected', 'true')

    // Now the search icon is the active one, so it folds as well — and the
    // choice survives the round trip.
    await search.click()
    await expect(page.getByTestId('sidebar-panes')).toBeHidden()
    await page.getByTestId('sidebar-fold').click()
    await expect(page.getByTestId('sidebar-panes')).toBeVisible()
    await expect(search).toHaveAttribute('aria-selected', 'true')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('sidebar: a non-active icon switches views without folding', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const switcher = page.getByTestId('sidebar-switcher')
    // Switching from one view to another is a switch, not a fold: pressing a
    // different icon must not leave the reader with a hidden pane.
    await switcher.getByRole('tab', { name: '搜索' }).click()
    await expect(page.getByTestId('sidebar-panes')).toBeVisible()
    expect(await folded(page)).toBe('false')
    await expect(switcher.getByRole('tab', { name: '搜索' })).toHaveAttribute('aria-selected', 'true')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('sidebar: the fold command is in the registry and gated on the column existing', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await expect(page.getByTestId('sidebar-view').first()).toBeVisible()
    const can = await page.evaluate(() => {
      const bridge = (window as unknown as {
        __diorama_page__: { getKernel(): { ctx: { commands: { canRun(id: string): boolean } } } }
      }).__diorama_page__
      const service = bridge.getKernel().ctx.commands
      return service.canRun('sidebar.toggleFolded')
    })
    expect(can).toBe(true)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
