/**
 * Selection in the row-per-line readers (contract.md §3.11).
 *
 * One `<div>` per line is what makes the gutter and `path:42` possible, and it
 * also broke the browser's own selection paint: it drew one rectangle per line,
 * of that line's length. The rule that fixes it is observable — a selection
 * across three lines must be **one block**: the rows it covers are filled edge
 * to edge and touch each other, not three strips of three lengths.
 */
import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/** A file with rows of very different lengths (the seam is the point). */
const UNEVEN = ['short', 'a much much longer line than the one above it', 'mid length line', 'x']

function content(page: import('@playwright/test').Page) {
  return page.getByTestId('tabs-content').filter({ visible: true })
}

/**
 * Select lines `from`…`to` by dragging from the start of the first to a point
 * **inside** the last — dragging past its end snaps to the end of the row,
 * which would select the whole line (right, but not what this measures).
 */
async function selectRows(page: import('@playwright/test').Page, from: number, to: number): Promise<void> {
  const pane = content(page)
  const first = pane.locator(`[data-line-number="${from}"] .diorama-line__text`)
  const last = pane.locator(`[data-line-number="${to}"] .diorama-line__text`)
  const start = await first.boundingBox()
  const end = await last.boundingBox()
  if (start === null || end === null) throw new Error('rows are not visible')
  await page.mouse.move(start.x + 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 6 })
  await page.mouse.up()
}

test('selection: a multi-line selection is one block, not a strip per line', async ({ page }) => {
  const directory = fixture({ 'src/uneven.ts': `${UNEVEN.join('\n')}\n` })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.locator('[data-path="src"]').click()
    await page.locator('[data-path="src/uneven.ts"]').click()
    const pane = content(page)
    await expect(pane.getByTestId('code-lines')).toBeVisible()

    await selectRows(page, 1, 3)

    // Rows 1 and 2 are covered to their end → full blocks; row 3 is only
    // touched → a partial run. This is the rule that joins them into one block.
    await expect(pane.locator('[data-line-number="1"]')).toHaveAttribute('data-sel', 'full')
    await expect(pane.locator('[data-line-number="2"]')).toHaveAttribute('data-sel', 'full')
    await expect(pane.locator('[data-line-number="3"]')).toHaveAttribute('data-sel', 'part')
    await expect(pane.locator('.diorama-line[data-sel]')).toHaveCount(3)

    // The two full blocks are exactly as wide as each other — despite text of
    // very different lengths — and they meet with no seam between them.
    const blocks = await pane.locator('.diorama-line[data-sel="full"]').evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect()
        return { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom) }
      }),
    )
    const [first, second] = blocks
    if (first === undefined || second === undefined) throw new Error('no blocks')
    expect(first.left).toBe(second.left)
    expect(first.right).toBe(second.right)
    expect(second.top).toBe(first.bottom)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('selection: the native highlight is transparent, text still copies', async ({ page }) => {
  const directory = fixture({ 'src/uneven.ts': `${UNEVEN.join('\n')}\n` })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.locator('[data-path="src"]').click()
    await page.locator('[data-path="src/uneven.ts"]').click()
    const pane = content(page)
    await expect(pane.getByTestId('code-lines')).toBeVisible()

    await selectRows(page, 1, 2)
    // The paint is ours (transparent native highlight)…
    const painted = await pane.locator('[data-line-number="1"]').evaluate(element => {
      const style = getComputedStyle(element, '::selection')
      return style.backgroundColor
    })
    expect(painted === 'rgba(0, 0, 0, 0)' || painted === 'transparent').toBe(true)
    // …and the text is still a real selection: copying it gives the lines back.
    const copied = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(copied).toContain('short')
    expect(copied).toContain('a much much longer line')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
