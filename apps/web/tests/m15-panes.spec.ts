import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Panes the reader can size, and long names that can be read (docs/m15/spec.md,
 * contract.md §5.2):
 *
 * - the left column's width is dragged by its edge, with the pointer and with
 *   the arrow keys, and remembered across a reload;
 * - a pane's list scrolls sideways instead of truncating a long name — the file
 *   tree, the changes, the history and the search results all do;
 * - the commit seat's file list has an edge of its own.
 */

/** A very long name: wider than the column, on purpose. */
const LONG = 'a-really-long-file-name-that-no-column-of-260-pixels-could-ever-show-in-full.ts'

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
}

/** The sidebar's width as the browser lays it out. */
async function sidebarWidth(page: Page): Promise<number> {
  return await page.getByTestId('sidebar-switcher').evaluate(element => {
    const column = element.closest('.diorama-layout__sidebar')
    return column === null ? -1 : Math.round(column.getBoundingClientRect().width)
  })
}

test('panes: the column edge drags, remembers the width and moves with the keyboard', async ({ page }) => {
  const directory = fixture({ [LONG]: 'x\n' })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const splitter = page.getByTestId('sidebar-splitter')
    await expect(splitter).toBeVisible()
    const before = await sidebarWidth(page)
    expect(before).toBeGreaterThan(200)

    // Drag the edge 120px to the right: the column is that much wider.
    const box = await splitter.boundingBox()
    if (box === null) throw new Error('the separator has no box')
    await page.mouse.move(box.x + box.width / 2, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + 40, { steps: 6 })
    await page.mouse.up()
    const dragged = await sidebarWidth(page)
    expect(dragged).toBeGreaterThanOrEqual(before + 110)

    // It is a preference: a reload comes back at the dragged width.
    await page.reload()
    await waitForPage(page)
    expect(await sidebarWidth(page)).toBe(dragged)

    // The keyboard reaches the same edge: Shift+Right is four steps.
    await page.getByTestId('sidebar-splitter').focus()
    await page.keyboard.press('Shift+ArrowRight')
    expect(await sidebarWidth(page)).toBe(dragged + 64)
    // Home goes to the narrowest width the primitive allows.
    await page.keyboard.press('Home')
    expect(await sidebarWidth(page)).toBe(160)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('panes: a long name is read by scrolling the pane, not by truncating it', async ({ page }) => {
  const directory = fixture({ [LONG]: 'x\n' })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const name = page.getByTestId('file-tree').locator(`[data-path="${LONG}"] .diorama-tree__name`)
    await expect(name).toHaveText(LONG)
    // No ellipsis: the element is as wide as the text it holds...
    const rendered = await name.evaluate(element => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflow: getComputedStyle(element).textOverflow,
    }))
    expect(rendered.overflow).not.toBe('ellipsis')
    expect(rendered.clientWidth).toBe(rendered.scrollWidth)
    // ...and the pane scrolls to it: it can be reached sideways.
    const pane = page.getByTestId('sidebar-pane').first()
    const scroll = await pane.evaluate(element => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('panes: the changes, history and search lists scroll sideways too', async ({ page }) => {
  const directory = fixture({ [LONG]: 'one\n' })
  git(directory.root, 'init', '-q', '-b', 'main')
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', `a subject long enough to run past the column: ${LONG}`)
  writeFileSync(join(directory.root, LONG), 'one\ntwo\n')
  mkdirSync(join(directory.root, 'nested', 'deep'), { recursive: true })
  writeFileSync(join(directory.root, 'nested', 'deep', LONG), 'needle in a very long path\n')
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const switcher = page.getByTestId('sidebar-switcher')

    // Changes: the row's name is whole, and the pane can scroll to it.
    await switcher.locator('[data-view="changes"]').click()
    const change = page.getByTestId('git-changes').locator(`[data-path="${LONG}"] .diorama-changes__name`)
    await expect(change).toHaveText(LONG)
    expect(await change.evaluate(element => element.clientWidth === element.scrollWidth)).toBe(true)
    const changesPane = page.getByTestId('sidebar-pane').filter({ has: page.getByTestId('git-changes') })
    expect(await changesPane.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)

    // History: the subject is whole as well.
    await switcher.locator('[data-view="history"]').click()
    const subject = page.getByTestId('git-history-commit').first().locator('.diorama-history__subject')
    await expect(subject).toContainText('a subject long enough')
    expect(await subject.evaluate(element => element.clientWidth === element.scrollWidth)).toBe(true)

    // Search: a hit's text is whole, and the results pane scrolls.
    await switcher.locator('[data-view="search"]').click()
    await page.getByTestId('search-input').fill('needle')
    const hit = page.getByTestId('search-match').first().locator('.diorama-search__text')
    await expect(hit).toBeVisible()
    expect(await hit.evaluate(element => element.clientWidth === element.scrollWidth)).toBe(true)
    expect(
      await page.getByTestId('search-results').evaluate(element => element.scrollWidth > element.clientWidth),
    ).toBe(true)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('panes: the commit seat file list has an edge of its own', async ({ page }) => {
  const directory = fixture({ [LONG]: 'one\n' })
  git(directory.root, 'init', '-q', '-b', 'main')
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', 'first')
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('sidebar-switcher').locator('[data-view="history"]').click()
    await page.getByTestId('git-history-commit').first().click()
    const splitter = page.getByTestId('git-commit-files-splitter')
    await expect(splitter).toBeVisible()
    const list = page.locator('.diorama-git-commit__files')
    const before = await list.evaluate(element => Math.round(element.getBoundingClientRect().width))
    const box = await splitter.boundingBox()
    if (box === null) throw new Error('the separator has no box')
    await page.mouse.move(box.x + box.width / 2, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + 20, { steps: 6 })
    await page.mouse.up()
    const after = await list.evaluate(element => Math.round(element.getBoundingClientRect().width))
    expect(after).toBeGreaterThanOrEqual(before + 130)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
