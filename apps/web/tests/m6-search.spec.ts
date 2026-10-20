import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * File search (contract.md §3.9, v0.8): the sidebar view (by name / by
 * content), quick open (`mod+p`), and "open a hit at its line".
 *
 * The line is the part that needs a browser: tabs carry a path only, so the hit
 * travels through `diorama-ui`'s reveal store and the renderer scrolls to it.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** A tree with a repeated word in two files, one of them nested. */
function searchable(): ReturnType<typeof fixture> {
  return fixture({
    'src/app.ts': 'export function hello() {\n  return "needle"\n}\n',
    'docs/guide.md': '# Guide\n\nA needle in a haystack.\nAnother line.\n',
  })
}

async function openSearch(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('sidebar-switcher').getByRole('tab', { name: '搜索' }).click()
  await expect(page.getByTestId('search-input')).toBeFocused()
}

test('search: the view finds text, lists hits and opens one at its line', async ({ page }) => {
  const directory = searchable()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await openSearch(page)

    await page.getByTestId('search-input').fill('needle')
    const results = page.getByTestId('search-results')
    await expect(results).toBeVisible()
    // Both files, each with its hit lines.
    await expect(page.getByTestId('search-file')).toHaveCount(2)
    await expect(page.getByTestId('search-status')).toContainText('2 个文件')
    await expect(page.getByTestId('search-status')).toContainText('2 处匹配')
    // The hit in `src/app.ts` is on line 2 (the walk order is not the point).
    const match = page.getByTestId('search-match').filter({ hasText: 'needle' }).and(page.locator('[data-path="src/app.ts"]'))
    await expect(match).toBeVisible()
    await expect(match).toHaveAttribute('data-line', '2')

    // Picking a hit opens the file in a tab and reveals that line.
    await match.click()
    await expect(page).toHaveURL(/\/~\/src\/app\.ts$/)
    const content = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(content.locator('[data-testid="renderer"]')).toHaveAttribute('data-renderer', 'code:renderer')
    await expect(content.getByTestId('code-reveal')).toHaveAttribute('data-line', '2')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('search: the file-name mode matches paths, not contents', async ({ page }) => {
  const directory = searchable()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await openSearch(page)

    // Content mode first: "guide" appears in a file name but not in any text.
    await page.getByTestId('search-input').fill('guide')
    await expect(page.getByTestId('search-results')).toHaveCount(0)

    await page.getByTestId('search-kind-name').click()
    await page.getByTestId('search-input').fill('guide')
    const files = page.getByTestId('search-file')
    await expect(files).toHaveCount(1)
    await expect(files.first()).toHaveAttribute('data-path', 'docs/guide.md')
    await files.first().click()
    await expect(page).toHaveURL(/\/~\/docs\/guide\.md$/)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('search: quick open jumps to a file by a subsequence of its path', async ({ page }) => {
  const directory = searchable()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.keyboard.press(`${MOD}+p`)
    const input = page.getByTestId('quick-open-input')
    await expect(input).toBeFocused()

    // "appts" is not a substring of "src/app.ts" — it is a subsequence.
    await input.fill('appts')
    const rows = page.getByTestId('quick-open-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-path', 'src/app.ts')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('quick-open')).toHaveCount(0)
    await expect(page).toHaveURL(/\/~\/src\/app\.ts$/)

    // Escape closes it without opening anything. The field takes focus on the
    // next tick (its own effect): press only after it does, or the key arrives
    // before the input that handles it exists.
    await page.keyboard.press(`${MOD}+p`)
    await expect(page.getByTestId('quick-open')).toBeVisible()
    await expect(page.getByTestId('quick-open-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('quick-open')).toHaveCount(0)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('search: the view has a switcher shortcut and stays mounted when hidden', async ({ page }) => {
  const directory = searchable()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    // mod+alt+4 shows the search view (contract.md §3.7).
    await page.keyboard.press(`${MOD}+Alt+4`)
    await expect(page.getByTestId('sidebar-switcher').getByRole('tab', { name: '搜索' })).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('search-input').fill('needle')
    await expect(page.getByTestId('search-file')).toHaveCount(2)
    // Switching away hides it but keeps the query and the results.
    await page.getByTestId('sidebar-switcher').getByRole('tab', { name: '文件' }).click()
    await expect(page.getByTestId('search')).toBeHidden()
    await page.getByTestId('sidebar-switcher').getByRole('tab', { name: '搜索' }).click()
    await expect(page.getByTestId('search-input')).toHaveValue('needle')
    await expect(page.getByTestId('search-file')).toHaveCount(2)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('search: options narrow the result set (case, whole word)', async ({ page }) => {
  const directory = fixture({
    'words.txt': 'Needle\nneedle\nneedles\n',
  })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await openSearch(page)

    await page.getByTestId('search-input').fill('needle')
    await expect(page.getByTestId('search-match')).toHaveCount(3)

    await page.getByTestId('search-case').click()
    await expect(page.getByTestId('search-match')).toHaveCount(2)

    await page.getByTestId('search-word').click()
    await expect(page.getByTestId('search-match')).toHaveCount(1)
    await expect(page.getByTestId('search-match')).toHaveAttribute('data-line', '2')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
