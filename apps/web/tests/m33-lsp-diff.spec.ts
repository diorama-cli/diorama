import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Go to definition inside the diff readers (contract.md §3.12, docs/m33/spec.md).
 *
 * The rows of a diff are not the text renderers' rows, so the gesture has to
 * find "line N of the file" through the diff's own row model — and only rows
 * that exist in the **current** file may be asked about. The three readers are
 * checked one by one, because they answer that question differently:
 *
 * - the inline reader's cell starts with git's + / - / space prefix;
 * - the whole-file reader draws the file's text but a deleted row has only an
 *   old number;
 * - the side-by-side reader's left column is the **old** file.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
}

/** A repository where a changed file calls a function declared in another file. */
function diffFixture() {
  const repo = fixture({
    'src/math.ts': ['export function add(a: number, b: number): number {', '  return a + b', '}', ''].join('\n'),
    'src/main.ts': ['import { add } from "./math.ts"', '', 'export function run() {', '  return 1', '}', ''].join('\n'),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' } }),
  })
  git(repo.root, 'init', '-q')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-qm', 'base')
  // The change under test: run now calls add.
  writeFileSync(
    join(repo.root, 'src/main.ts'),
    ['import { add } from "./math.ts"', '', 'export function run() {', '  return add(1, 2)', '}', ''].join('\n'),
  )
  return repo
}

/** Open one file's diff in the changes view and return its reader. */
async function openDiff(page: Page, url: string, path: string) {
  await page.goto(url)
  await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
  await page.getByTestId('git-changes').locator('[data-path="' + path + '"]').click()
  const diff = page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')
  await expect(diff).toBeVisible()
  return diff
}

/** The centre of the word "add" inside the given selector, measured with a Range. */
async function pointOf(page: Page, scope: string): Promise<{ x: number; y: number } | null> {
  return await page.evaluate(selector => {
    const cells = [...document.querySelectorAll(selector)]
    for (const cell of cells) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = (node.textContent ?? '').indexOf('add')
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 3)
        const rect = range.getBoundingClientRect()
        if (rect.width === 0) continue
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
    }
    return null
  }, scope)
}

/**
 * Warm the language server before a jump is asserted.
 *
 * Its first answer is provisional and the service confirms it by asking again
 * (docs/m33/spec.md §6), which costs a couple of seconds. Under the full
 * suite's load that is enough to blow the assertion's timeout, so the warm-up
 * is explicit rather than hoped for.
 */
async function warm(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bridge = (window as unknown as {
      __diorama_page__?: { getKernel(): { mount: { lsp: { definition(p: string, at: unknown): Promise<unknown> } } } | undefined }
    }).__diorama_page__
    const mount = bridge?.getKernel()?.mount
    if (mount === undefined) throw new Error('the page did not boot')
    await mount.lsp.definition('src/main.ts', { line: 4, character: 10 })
  })
}

/** Command-click a point. */
async function commandClick(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.keyboard.down(MOD)
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up(MOD)
}

test('diff: the whole-file reader jumps to the declaration', async ({ page }) => {
  const repo = diffFixture()
  const server = await startDiorama(repo.root)
  try {
    const diff = await openDiff(page, server.url, 'src/main.ts')
    await waitForPage(page)
    await warm(page)
    await diff.getByTestId('git-diff-mode-file').click()
    const surface = diff.getByTestId('git-diff-text')
    await expect(surface).toHaveAttribute('data-mode', 'file')

    const point = await pointOf(page, '[data-testid="git-diff-text"][data-mode="file"] [data-new-line] .diorama-diff__code')
    expect(point).not.toBeNull()
    if (point === null) return
    await commandClick(page, point)

    const active = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(active.getByTestId('code-path')).toHaveText('src/math.ts')
    await expect(active.getByTestId('code-reveal').first()).toBeVisible()
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('diff: the inline reader drops the diff prefix before asking', async ({ page }) => {
  const repo = diffFixture()
  const server = await startDiorama(repo.root)
  try {
    const diff = await openDiff(page, server.url, 'src/main.ts')
    await waitForPage(page)
    await warm(page)
    await diff.getByTestId('git-diff-mode-inline').click()
    // The inline reader is the one whose rows are the unified diff: it is the
    // only one that draws a tone="del" row (the other two readers put a
    // deletion inside the file's own rows).
    await expect(diff.locator('.diorama-diff__line[data-tone="del"]').first()).toBeVisible()

    // Only rows that exist in the current file carry data-new-line; a deleted
    // line does not, and must not be asked about.
    const point = await pointOf(page, '[data-testid="git-diff-text"] [data-new-line] .diorama-diff__code')
    expect(point).not.toBeNull()
    if (point === null) return
    await commandClick(page, point)

    const active = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(active.getByTestId('code-path')).toHaveText('src/math.ts')
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('diff: a deleted line is not addressable', async ({ page }) => {
  const repo = diffFixture()
  const server = await startDiorama(repo.root)
  try {
    const diff = await openDiff(page, server.url, 'src/main.ts')
    await waitForPage(page)
    await warm(page)
    await diff.getByTestId('git-diff-mode-inline').click()
    const deleted = diff.locator('.diorama-diff__line[data-tone="del"]')
    await expect(deleted.first()).toBeVisible()
    await expect(deleted.first()).not.toHaveAttribute('data-new-line', /./)
    const added = diff.locator('.diorama-diff__line[data-tone="add"]').first()
    await expect(added).toHaveAttribute('data-new-line', /\d+/)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('diff: the side-by-side reader only addresses the new column', async ({ page }) => {
  const repo = diffFixture()
  const server = await startDiorama(repo.root)
  try {
    const diff = await openDiff(page, server.url, 'src/main.ts')
    await waitForPage(page)
    await warm(page)
    await diff.getByTestId('git-diff-mode-split').click()
    const surface = diff.getByTestId('git-diff-text')
    await expect(surface).toHaveAttribute('data-mode', 'split')

    // The left cell of a changed row is the old file: no data-new-line.
    const addressed = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('[data-testid="git-diff-text"] .diorama-diff__split-cell')]
      const left = cells.filter((_, index) => index % 2 === 0)
      const right = cells.filter((_, index) => index % 2 === 1)
      return {
        left: left.filter(cell => cell.hasAttribute('data-new-line')).length,
        right: right.filter(cell => cell.hasAttribute('data-new-line')).length,
      }
    })
    expect(addressed.left).toBe(0)
    expect(addressed.right).toBeGreaterThan(0)

    const point = await pointOf(page, '[data-testid="git-diff-text"] [data-new-line] .diorama-diff__code')
    expect(point).not.toBeNull()
    if (point === null) return
    await commandClick(page, point)
    const active = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(active.getByTestId('code-path')).toHaveText('src/math.ts')
  } finally {
    await server.stop()
    repo.dispose()
  }
})
