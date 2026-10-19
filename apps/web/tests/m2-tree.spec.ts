import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { fixture, startDiorama } from './support.ts'

/**
 * M2 S2 (docs/m2/spec.md §4 rows 3–4): the tree hides what `ignore` hides and
 * loads big directories in pages.
 */

test('4. a large directory lists one page and grows on request', async ({ page }) => {
  const directory = fixture()
  const bulk = join(directory.root, 'bulk')
  mkdirSync(bulk)
  for (let index = 0; index < 600; index++) writeFileSync(join(bulk, `file-${String(index).padStart(3, '0')}.txt`), 'x\n')
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="bulk"]').click()
    // The first PAGE_SIZE (500) of 600 rows, then the rest on request.
    await expect(tree.locator('[data-path^="bulk/file-"]')).toHaveCount(500)
    await expect(tree.getByTestId('tree-more')).toHaveText('加载更多（已显示 500 / 共 600 条）')
    await tree.getByTestId('tree-more').click()
    await expect(tree.locator('[data-path^="bulk/file-"]')).toHaveCount(600)
    await expect(tree.getByTestId('tree-more')).toHaveCount(0)
    // The last page's entries are real files: clicking one opens a tab.
    await tree.locator('[data-path="bulk/file-599.txt"]').click()
    await expect(page.getByTestId('active-tab')).toHaveText('file-599.txt')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('4b. hidden entries cannot be expanded: the tree only shows what list returns', async ({ page }) => {
  const directory = fixture()
  mkdirSync(join(directory.root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(directory.root, 'node_modules', 'pkg', 'index.js'), 'x\n')
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    const tree = page.getByTestId('file-tree')
    await expect(tree.locator('[data-path="node_modules"]')).toHaveCount(0)
    await expect(tree.locator('[data-path="node_modules/pkg"]')).toHaveCount(0)
    // Nothing else regressed.
    await expect(tree.locator('[data-path="README.md"]')).toBeVisible()
  } finally {
    await server.stop()
    directory.dispose()
  }
})
