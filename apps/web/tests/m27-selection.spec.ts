/**
 * Selection in the row-per-line readers (contract.md §3.11).
 *
 * One `<div>` per line is what makes the gutter and `path:42` possible, and it
 * also broke the browser's own selection paint: it drew one rectangle per line,
 * of that line's length. The rule that fixes it is observable — a selection
 * across three lines must be **one block**: the rows it covers are filled from
 * the text column to the right edge and touch each other, not three strips of
 * three lengths. The gutter stays out of it (the line number is not selected),
 * and a row the selection starts **in the middle of** shows only its tail.
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

    // …and the block starts at the text column: the gutter (the line number) is
    // not painted as selected, on every row alike. Rows that are selected from
    // their beginning measure their left at 0 (there the block does start at the
    // text column); a row selected from the middle measures where its run starts.
    const geometry = await pane.locator('.diorama-line[data-sel]').evaluateAll(elements =>
      elements.map(element => {
        const row = element.getBoundingClientRect()
        const num = element.querySelector('.diorama-line__num')?.getBoundingClientRect()
        const text = element.querySelector('.diorama-line__text')?.getBoundingClientRect()
        const style = getComputedStyle(element)
        const gutter = Number.parseFloat(style.getPropertyValue('--dio-line-gutter'))
        const run = Number.parseFloat(style.getPropertyValue('--dio-sel-left'))
        return {
          rowLeft: Math.round(row.left),
          numRight: Math.round(num?.right ?? 0),
          textLeft: Math.round(text?.left ?? 0),
          // Where the painted box begins: the row's left, plus the text column,
          // plus the measured run inside the text.
          blockLeft: Math.round(row.left + gutter + (Number.isFinite(run) ? run : 0)),
        }
      }),
    )
    for (const row of geometry) {
      expect(row.numRight).toBeGreaterThan(row.rowLeft) // there is a gutter to leave out
      expect(row.blockLeft).toBeGreaterThanOrEqual(row.numRight) // the block never covers the number
    }
    // Every row here is selected from its beginning, so every block starts exactly
    // at the text column — that is what lines them up with each other.
    for (const row of geometry) expect(row.blockLeft).toBe(row.textLeft)
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

test('selection: a row the drag starts inside shows only its tail', async ({ page }) => {
  const directory = fixture({ 'src/uneven.ts': `${UNEVEN.join('\n')}\n` })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.locator('[data-path="src"]').click()
    await page.locator('[data-path="src/uneven.ts"]').click()
    const pane = content(page)
    await expect(pane.getByTestId('code-lines')).toBeVisible()

    // Start **inside** the first row, not at its beginning: the drag reaches a
    // character in the middle, so only the tail of that row is selected.
    const firstText = await pane.locator('[data-line-number="1"] .diorama-line__text').boundingBox()
    const lastText = await pane.locator('[data-line-number="3"] .diorama-line__text').boundingBox()
    if (firstText === null || lastText === null) throw new Error('rows are not visible')
    await page.mouse.move(firstText.x + firstText.width * 0.6, firstText.y + firstText.height / 2)
    await page.mouse.down()
    await page.mouse.move(lastText.x + lastText.width / 2, lastText.y + lastText.height / 2, { steps: 6 })
    await page.mouse.up()

    const measure = (line: number) =>
      pane.locator(`[data-line-number="${line}"]`).evaluate(element => {
        const style = getComputedStyle(element)
        const row = element.getBoundingClientRect()
        const text = element.querySelector('.diorama-line__text')?.getBoundingClientRect()
        const num = element.querySelector('.diorama-line__num')?.getBoundingClientRect()
        const gutter = Number.parseFloat(style.getPropertyValue('--dio-line-gutter'))
        const run = Number.parseFloat(style.getPropertyValue('--dio-sel-left'))
        return {
          sel: element.getAttribute('data-sel'),
          run: Number.isFinite(run) ? run : 0,
          rowLeft: Math.round(row.left),
          numRight: Math.round(num?.right ?? 0),
          textLeft: Math.round(text?.left ?? 0),
          blockLeft: Math.round(row.left + gutter + (Number.isFinite(run) ? run : 0)),
        }
      })

    // The first row is not a block: the box starts where the selected characters
    // start, which is past the text column — and still past the line number.
    const head = await measure(1)
    expect(head.sel).toBe('part')
    expect(head.run).toBeGreaterThan(0)
    expect(head.blockLeft).toBeGreaterThan(head.textLeft)
    expect(head.blockLeft).toBeGreaterThanOrEqual(head.numRight)

    // The row below starts where its text starts, as before: the tail of the
    // first row and the block below line up on the same column.
    const below = await measure(2)
    expect(below.blockLeft).toBe(below.textLeft)

    // And the selection itself starts at a character, not at the row's beginning.
    const copied = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(copied.startsWith('short')).toBe(false)
    expect(copied).toContain('mid leng')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
