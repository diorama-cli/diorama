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
