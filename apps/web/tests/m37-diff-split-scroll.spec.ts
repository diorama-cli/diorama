import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama } from './support.ts'

/**
 * The side-by-side diff reader pans **a whole side** when a line is wider than
 * its column (contract.md §5.2, docs/m37/spec.md).
 *
 * A cell of the two-column reader is a row model with `white-space: pre`, so
 * the text is as wide as the line. Giving each cell its own scroller (the first
 * attempt) made **every row** a scrollbar: a cell is one line tall, so panning
 * the column lit one scrollbar per line. The fix is one offset per side — the
 * code column is shifted with a transform and the cell clips it — so there is
 * no scrollbar anywhere and the gutter never moves.
 *
 * The assertions are geometry and gestures: a cell at its half-row width, no
 * sideways scroller on any row, and a pan that slides the whole side under a
 * gutter that stays put.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
}

/** A line far wider than half a reader, so the side must pan it. */
const wide = (index: number) => 'const line' + index + ' = "' + String(index).repeat(120) + '"'

const BEFORE = ['const a = 1', wide(1), wide(2), wide(3), 'const b = 2', ''].join('\n')
const AFTER = ['const a = 1', wide(1) + ' // one', wide(2) + ' // two', wide(3) + ' // three', 'const b = 2', ''].join('\n')

/** Open one file's diff in the changes view, and return its reader. */
async function openSplit(page: Page, url: string, path: string) {
  await page.goto(url)
  await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
  await page.getByTestId('git-changes').locator('[data-path="' + path + '"]').click()
  const diff = page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')
  await expect(diff).toBeVisible()
  await diff.getByTestId('git-diff-mode-split').click()
  await expect(diff.getByTestId('git-diff-text')).toHaveAttribute('data-mode', 'split')
  return diff
}

/** Every code column's horizontal shift, read back from its computed transform. */
const shifts = (element: Element): number[] =>
  [...element.querySelectorAll<HTMLElement>('.diorama-diff__code')].map(code => {
    const matrix = getComputedStyle(code).transform
    if (matrix === 'none') return 0
    return Math.round(new DOMMatrixReadOnly(matrix).m41)
  })

test('diff: a long line is clipped by its column and pans there', async ({ page }) => {
  const repo = fixture()
  writeFileSync(join(repo.root, 'src/wide.js'), BEFORE)
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'src/wide.js'), AFTER)
  const server = await startDiorama(repo.root)
  try {
    const diff = await openSplit(page, server.url, 'src/wide.js')
    const split = diff.getByTestId('git-diff-text')
    const row = split.locator('.diorama-diff__split-row').filter({ hasText: 'line2' })
    await expect(row).toHaveCount(1)

    // The reader itself never scrolls sideways.
    const reader = await split.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(reader.scrollWidth).toBeLessThanOrEqual(reader.clientWidth + 1)

    // Nothing inside the reader scrolls sideways either: that is what put a
    // scrollbar on every line before.
    const scrollers = await split.evaluate(element =>
      [...element.querySelectorAll<HTMLElement>('*')].filter(node => {
        const overflow = getComputedStyle(node).overflowX
        return overflow === 'auto' || overflow === 'scroll'
      }).length,
    )
    expect(scrollers).toBe(0)

    // Every cell stays at half the row, and the text is wider than what it
    // shows — the column clips it instead of growing.
    const shape = await row.evaluate(element => {
      const cells = [...element.querySelectorAll<HTMLElement>('.diorama-diff__split-cell')]
      const box = element.getBoundingClientRect()
      return {
        rowWidth: box.width,
        rowLeft: box.left,
        rowRight: box.right,
        cells: cells.map(cell => {
          const code = cell.querySelector<HTMLElement>('.diorama-diff__code')
          if (code === null) throw new Error('no code column')
          const rect = cell.getBoundingClientRect()
          return {
            side: cell.dataset.side,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            clientWidth: code.clientWidth,
            scrollWidth: code.scrollWidth,
            overflowX: getComputedStyle(cell).overflowX,
            text: code.textContent ?? '',
          }
        }),
      }
    })
    expect(shape.cells).toHaveLength(2)
    for (const cell of shape.cells) {
      expect(cell.width).toBeLessThanOrEqual(shape.rowWidth / 2 + 1)
      expect(cell.left).toBeGreaterThanOrEqual(shape.rowLeft - 1)
      expect(cell.right).toBeLessThanOrEqual(shape.rowRight + 1)
      // Clipped, not scrollable.
      expect(cell.overflowX).toBe('hidden')
      expect(cell.scrollWidth).toBeGreaterThan(cell.clientWidth)
    }
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('diff: a pan slides the whole side, and the gutter stays put', async ({ page }) => {
  const repo = fixture()
  writeFileSync(join(repo.root, 'src/wide.js'), BEFORE)
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'src/wide.js'), AFTER)
  const server = await startDiorama(repo.root)
  try {
    await page.setViewportSize({ width: 1100, height: 700 })
    const diff = await openSplit(page, server.url, 'src/wide.js')
    const split = diff.getByTestId('git-diff-text')
    const cell = split.locator('.diorama-diff__split-cell').filter({ hasText: 'line2' }).last()
    const box = (await cell.boundingBox())!

    // A touchpad's horizontal pan arrives as a wheel with `deltaX`; Shift +
    // wheel is the same gesture for a mouse. Both slide the side the pointer is
    // over, and leave the reader where it is.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.mouse.wheel(200, 0)
      await page.waitForTimeout(120)
      if ((await split.evaluate(shifts)).some(shift => shift !== 0)) break
    }
    const afterSwipe = await split.evaluate(shifts)
    // Only the side under the pointer moved, and every line of it moved by the
    // same amount — the side slides as one.
    const movedBy = afterSwipe.filter(shift => shift !== 0)
    expect(movedBy.length).toBeGreaterThanOrEqual(3)
    expect(new Set(movedBy).size).toBe(1)
    expect(movedBy[0]).toBeLessThan(0)

    // The gutter is outside the transform: it does not move.
    const gutterShift = await split.evaluate(element => {
      const target = [...element.querySelectorAll<HTMLElement>('.diorama-diff__split-cell')].find(each =>
        (each.textContent ?? '').includes('line2'),
      )
      if (target === undefined) throw new Error('no cell with the long line')
      const gutter = target.querySelector<HTMLElement>('.diorama-diff__num')
      if (gutter === null) throw new Error('no gutter')
      const matrix = getComputedStyle(gutter).transform
      return matrix === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(matrix).m41)
    })
    expect(gutterShift).toBe(0)

    await page.keyboard.down('Shift')
    await page.mouse.wheel(0, 200)
    await page.keyboard.up('Shift')
    await page.waitForTimeout(150)
    const afterShift = await split.evaluate(shifts)
    const shifted = afterShift.filter(shift => shift !== 0)
    expect(shifted.length).toBe(movedBy.length)
    expect(new Set(shifted).size).toBe(1)
    expect(shifted[0]).toBeLessThan(movedBy[0] as number)

    const readerLeft = await split.evaluate(element => (element as HTMLElement).scrollLeft)
    expect(readerLeft).toBe(0)
  } finally {
    await server.stop()
    repo.dispose()
  }
})
