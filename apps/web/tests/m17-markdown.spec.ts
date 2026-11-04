import { expect, test } from '@playwright/test'
import { fixture, startDiorama } from './support.ts'

/**
 * Math, diagrams and the outline (contract.md §5.1, docs/m17/spec.md).
 *
 * Three things a Markdown document can now carry beyond HTML:
 *
 * - `$x^2$` / `$$…$$` → KaTeX, loaded **only when a document has math;
 * - a `mermaid` fence → Mermaid, likewise;
 * - an outline rail **inside the tab**, beside the article — the headings of
 *   this file, not a view of the left column.
 *
 * The libraries are served from the piece's own package
 * (`/plugins/markdown/vendor/…`), which is what lets a document without math
 * cost nothing: the assertions below check both halves of that rule.
 */

/**
 * Tall enough above **and below** the second heading that the scroll is both
 * needed and able to put it at the top: a heading near the end of the document
 * can only be scrolled as far as the last line allows.
 */
const FILLER = Array.from({ length: 60 }, (_, index) => `paragraph ${index + 1}\n`).join('\n')

const MATH = [
  '# Math paper',
  '',
  'The identity $e^{i\\pi} + 1 = 0$ holds, and money costs $5 or $6.',
  '',
  '$$',
  '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
  '$$',
  '',
  ...FILLER,
  '',
  '## Second part',
  '',
  'text',
  '',
  ...FILLER,
  '',
].join('\n')

const DIAGRAM = [
  '# Diagram page',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B[End]',
  '```',
  '',
].join('\n')

const PLAIN = ['# Plain', '', 'no math here, and $5 is just money.', ''].join('\n')

/** A document whose headings are enough for a rail (the threshold is two). */
const HEADED = ['# One', '', 'body', '', '## Two', '', 'body', '', '### Three', '', 'body', ''].join('\n')

test('markdown math: a formula renders through KaTeX, loaded on demand', async ({ page }) => {
  const directory = fixture({ 'MATH.md': MATH })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/MATH.md`)
    await expect(page.getByTestId('markdown')).toBeVisible()
    // KaTeX renders into the placeholder; its own DOM is the proof it ran.
    const formula = page.locator('.diorama-markdown .diorama-math[data-math="inline"]').first()
    await expect(formula.locator('.katex')).toHaveCount(1)
    // A block formula is display math, in a block-level placeholder.
    const block = page.locator('.diorama-markdown .diorama-math--block')
    await expect(block.locator('.katex-display')).toHaveCount(1)
    // `$5 or $6` is money: the parser must not have read it as a formula.
    await expect(page.locator('.diorama-markdown p', { hasText: 'money costs' })).toContainText('$5 or $6')
    // The stylesheet travelled with the piece, and its fonts resolve.
    const css = await page.evaluate(() =>
      Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(link => link.getAttribute('href')),
    )
    expect(css.some(href => href?.includes('/plugins/markdown/vendor/katex.min.css'))).toBe(true)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('markdown math: a document without math loads neither library', async ({ page }) => {
  const directory = fixture({ 'PLAIN.md': PLAIN })
  const server = await startDiorama(directory.root)
  const requested: string[] = []
  page.on('request', request => requested.push(new URL(request.url()).pathname))
  try {
    await page.goto(`${server.url}~/PLAIN.md`)
    await expect(page.locator('.diorama-markdown h1')).toHaveText('Plain')
    expect(requested.filter(path => path.includes('/vendor/'))).toEqual([])
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('markdown mermaid: a fence becomes a diagram', async ({ page }) => {
  const directory = fixture({ 'DIAGRAM.md': DIAGRAM })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/DIAGRAM.md`)
    const diagram = page.locator('.diorama-markdown .diorama-mermaid')
    await expect(diagram).toHaveAttribute('data-state', 'rendered')
    await expect(diagram.locator('svg')).toHaveCount(1)
    // The labels come from the document, so this is *this* diagram.
    await expect(diagram).toContainText('Start')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
test('outline: the rail lists this document\'s headings and scrolls to one', async ({ page }) => {
  const directory = fixture({ 'HEADED.md': HEADED })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/HEADED.md`)
    const rail = page.getByTestId('outline')
    await expect(rail).toBeVisible()
    const rows = rail.locator('.diorama-outline__row')
    await expect(rows).toHaveCount(3)
    await expect(rows.first()).toHaveText('One')
    await expect(rows.nth(1)).toHaveText('Two')
    // Levels are normalised: `h1` is the root, `h2` under it, `h3` under that.
    await expect(rows.nth(1)).toHaveAttribute('data-depth', '2')
    await expect(rows.nth(2)).toHaveAttribute('data-depth', '3')
    // The rail lives **inside the tab**, beside the article — not in the column.
    await expect(page.getByTestId('sidebar-switcher').locator('[data-view="outline"]')).toHaveCount(0)
    expect(await rail.evaluate(element => element.closest('[data-testid="tabs-content"]') !== null)).toBe(true)
    // It is a **column, not a floating layer** (docs/m17/spec.md §3): the pane
    // is painted (the text scrolling under the sticky rail must not show
    // through between the rows) and rides above the article.
    const surface = await page.evaluate(() => {
      const pane = document.querySelector('.diorama-outline-pane') as HTMLElement
      const rail = document.querySelector('.diorama-outline') as HTMLElement
      const style = getComputedStyle(pane)
      return {
        background: style.backgroundColor,
        zIndex: style.zIndex,
        railPosition: getComputedStyle(rail).position,
      }
    })
    expect(surface.railPosition).toBe('sticky')
    expect(surface.zIndex).not.toBe('auto')
    expect(surface.background).not.toBe('rgba(0, 0, 0, 0)')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('outline: clicking a row scrolls this article to that heading', async ({ page }) => {
  const directory = fixture({ 'MATH.md': MATH })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/MATH.md`)
    const rail = page.getByTestId('outline')
    await expect(rail.locator('.diorama-outline__row')).toHaveCount(2)
    await rail.locator('.diorama-outline__row', { hasText: 'Second part' }).click()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const heading = Array.from(document.querySelectorAll('.diorama-markdown h2')).find(
            element => element.textContent === 'Second part',
          )
          if (heading === undefined) return Number.POSITIVE_INFINITY
          return Math.abs(heading.getBoundingClientRect().top)
        }),
      )
      .toBeLessThan(80)
    // The row of the section being read is marked as the current one.
    await expect(rail.locator('.diorama-outline__row--current')).toHaveText('Second part')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('outline: the pane paints the whole column, not just the headings', async ({ page }) => {
  const directory = fixture({ 'HEADED.md': HEADED })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/HEADED.md`)
    await expect(page.getByTestId('outline')).toBeVisible()
    const geometry = await page.evaluate(() => {
      const pane = document.querySelector('.diorama-outline-pane') as HTMLElement
      const rail = document.querySelector('.diorama-outline') as HTMLElement
      const article = document.querySelector('.diorama-markdown') as HTMLElement
      return {
        paneHeight: Math.round(pane.getBoundingClientRect().height),
        railHeight: Math.round(rail.getBoundingClientRect().height),
        articleHeight: Math.round(article.getBoundingClientRect().height),
        background: getComputedStyle(pane).backgroundColor,
        borderLeft: getComputedStyle(pane).borderLeftWidth,
      }
    })
    // A sticky box is only as tall as its content, so the surface belongs to
    // the pane: it runs the full height of the article, headings or not.
    expect(geometry.railHeight).toBeLessThan(geometry.paneHeight)
    expect(Math.abs(geometry.paneHeight - geometry.articleHeight)).toBeLessThanOrEqual(1)
    expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)')
    expect(geometry.borderLeft).not.toBe('0px')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
test('outline: the rail is flush with the right edge of the tab', async ({ page }) => {
  const directory = fixture({ 'HEADED.md': HEADED })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/HEADED.md`)
    await expect(page.getByTestId('outline')).toBeVisible()
    const edges = await page.evaluate(() => {
      const rail = document.querySelector('.diorama-outline') as HTMLElement
      const scroller = rail.closest('.diorama-tabs__content') as HTMLElement
      return {
        railRight: Math.round(rail.getBoundingClientRect().right),
        scrollerRight: Math.round(scroller.getBoundingClientRect().right),
      }
    })
    // A pane, not a card floating in a gutter: no trailing margin.
    expect(Math.abs(edges.railRight - edges.scrollerRight)).toBeLessThanOrEqual(1)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('outline: the rail is a pane whose width is dragged and remembered', async ({ page }) => {
  const directory = fixture({ 'HEADED.md': HEADED })
  const server = await startDiorama(directory.root)
  const railWidth = async (): Promise<number> =>
    await page.getByTestId('outline').evaluate(element => Math.round(element.getBoundingClientRect().width))
  try {
    await page.goto(`${server.url}~/HEADED.md`)
    const splitter = page.getByTestId('outline-splitter')
    await expect(splitter).toBeVisible()
    const before = await railWidth()
    expect(before).toBeGreaterThan(140)

    // Dragging **left** widens a pane that sits to the right of the edge.
    const box = await splitter.boundingBox()
    if (box === null) throw new Error('the separator has no box')
    expect(box.height).toBeGreaterThan(100)
    await page.mouse.move(box.x + box.width / 2, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 90, box.y + 40, { steps: 6 })
    await page.mouse.up()
    const dragged = await railWidth()
    expect(dragged).toBeGreaterThanOrEqual(before + 80)

    // It is a preference: a reload comes back at the dragged width.
    await page.reload()
    await expect(page.getByTestId('outline')).toBeVisible()
    expect(await railWidth()).toBe(dragged)

    // The keyboard reaches the same edge: Shift+Left is four steps wider.
    await page.getByTestId('outline-splitter').focus()
    await page.keyboard.press('Shift+ArrowLeft')
    expect(await railWidth()).toBe(dragged + 64)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
test('outline: the rail keeps its surface while the article scrolls under it', async ({ page }) => {
  const directory = fixture({ 'MATH.md': MATH })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/MATH.md`)
    await expect(page.getByTestId('outline')).toBeVisible()
    const before = await page.evaluate(() => {
      const rail = document.querySelector('.diorama-outline') as HTMLElement
      const scroller = rail.closest('.diorama-tabs__content') as HTMLElement
      return { railTop: Math.round(rail.getBoundingClientRect().top), scrollerTop: Math.round(scroller.getBoundingClientRect().top) }
    })
    // Scroll the article: the rail sticks to the top of the tab's box instead of
    // travelling with the text, and it is still painted (no text shows through).
    await page.locator('.diorama-tabs__content').evaluate(element => {
      ;(element as HTMLElement).scrollTop = 900
    })
    const after = await page.evaluate(() => {
      const rail = document.querySelector('.diorama-outline') as HTMLElement
      const pane = document.querySelector('.diorama-outline-pane') as HTMLElement
      const scroller = rail.closest('.diorama-tabs__content') as HTMLElement
      return {
        railTop: Math.round(rail.getBoundingClientRect().top),
        scrollerTop: Math.round(scroller.getBoundingClientRect().top),
        // The surface belongs to the **pane** (a sticky box is only as tall as
        // its content), so that is what has to stay painted.
        background: getComputedStyle(pane).backgroundColor,
        scrollTop: Math.round(scroller.scrollTop),
      }
    })
    expect(after.scrollTop).toBeGreaterThan(500)
    // It moved up with the scroll and then stopped at the top edge of the box.
    expect(after.railTop).toBeLessThan(before.railTop)
    expect(Math.abs(after.railTop - after.scrollerTop)).toBeLessThanOrEqual(1)
    expect(after.background).not.toBe('rgba(0, 0, 0, 0)')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('outline: a wide table scrolls in the article and never paints over the rail', async ({ page }) => {
  const WIDE = ['# Wide', '', '| a | b |', '|---|---|', `| ${'x'.repeat(400)} | b |`, '', '## Second', '', 'text', ''].join('\n')
  const directory = fixture({ 'WIDE.md': WIDE })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/WIDE.md`)
    await expect(page.getByTestId('outline')).toBeVisible()
    const geometry = await page.evaluate(() => {
      const rail = document.querySelector('.diorama-outline') as HTMLElement
      const table = document.querySelector('.diorama-markdown table') as HTMLElement
      const body = document.querySelector('.diorama-markdown-body') as HTMLElement
      return {
        railLeft: rail.getBoundingClientRect().left,
        tableRight: table.getBoundingClientRect().right,
        // The flex box's own scroll width must not include the rail's column.
        overflow: body.scrollWidth - body.clientWidth,
      }
    })
    // The table's box stops at the article's edge (its own content scrolls).
    expect(geometry.tableRight).toBeLessThanOrEqual(geometry.railLeft)
    expect(geometry.overflow).toBeLessThanOrEqual(1)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('outline: each tab keeps its own rail', async ({ page }) => {
  const directory = fixture({ 'HEADED.md': HEADED, 'PLAIN.md': PLAIN })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/HEADED.md`)
    await expect(page.getByTestId('outline').locator('.diorama-outline__row')).toHaveCount(3)
    // A document with a single heading has no rail: one heading is the title
    // the reader can already see.
    await page.getByTestId('file-tree').locator('[data-path="PLAIN.md"]').click()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)
    const visible = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(visible.getByTestId('outline')).toHaveCount(0)
    // Going back shows the first document's rail again, still its own.
    await page.locator('.diorama-tabs__strip [role="tab"] .diorama-tabs__label', { hasText: 'HEADED.md' }).click()
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('outline').locator('.diorama-outline__row')).toHaveCount(3)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
