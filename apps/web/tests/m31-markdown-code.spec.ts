import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Fenced code in a Markdown document (contract.md §5.1, §30; docs/m31/spec.md).
 *
 * A fence is coloured by the **page's** engine — the one `code` publishes
 * (`__diorama_highlight__`), which is also what the `code` renderer and the
 * diff readers use. Nothing is registered twice: a snippet in a document and
 * the same snippet in a file are the same six tokens.
 *
 * The piece never *needs* that engine: a page whose plugin selection leaves
 * `code` out still shows the fence, as escaped text.
 */

const DOC = [
  '# Snippets',
  '',
  '\u0060\u0060\u0060js',
  'function greet(name) {',
  '  // a comment',
  '  const message = "hello"',
  '  return message + name',
  '}',
  '\u0060\u0060\u0060',
  '',
  'An unknown language is still text:',
  '',
  '\u0060\u0060\u0060notalanguage',
  '<b>not markup</b>',
  '\u0060\u0060\u0060',
  '',
].join('\n')

test('markdown code: a fence is highlighted with the page engine', async ({ page }) => {
  const directory = fixture({ 'DOC.md': DOC })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/DOC.md`)
    const block = page.locator('.diorama-markdown pre').first()
    await expect(block).toHaveAttribute('data-language', 'javascript')
    // The three token kinds the document writes are drawn.
    await expect(block.locator('.hljs-keyword').first()).toBeVisible()
    await expect(block.locator('.hljs-comment')).toContainText('// a comment')
    await expect(block.locator('.hljs-string')).toContainText('hello')
    // Colour comes from the shared token table, not from a per-piece palette:
    // a probe element painted with `var(--dio-syn-keyword)` and the token span
    // must resolve to the same colour.
    const colours = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--dio-syn-keyword)'
      document.body.appendChild(probe)
      const token = getComputedStyle(probe).color
      probe.remove()
      const span = document.querySelector('.diorama-markdown pre .hljs-keyword')
      return { token, span: span === null ? '' : getComputedStyle(span).color }
    })
    expect(colours.token).not.toBe('')
    expect(colours.span).toBe(colours.token)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('markdown code: an unknown language stays escaped text', async ({ page }) => {
  const directory = fixture({ 'DOC.md': DOC })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(`${server.url}~/DOC.md`)
    const block = page.locator('.diorama-markdown pre').nth(1)
    await expect(block.locator('.hljs-keyword')).toHaveCount(0)
    // The markup in the fence is shown, not interpreted.
    await expect(block.locator('b')).toHaveCount(0)
    await expect(block).toContainText('<b>not markup</b>')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('markdown code: a page without the code piece still shows the fence', async ({ page }) => {
  const directory = fixture({ 'DOC.md': DOC })
  const server = await startDiorama(directory.root, [
    '--plugins',
    'slots,layout,file-tree,tabs,renderer-registry,plaintext,markdown',
  ])
  try {
    await page.goto(`${server.url}~/DOC.md`)
    await waitForPage(page)
    const block = page.locator('.diorama-markdown pre').first()
    await expect(block).toContainText('function greet')
    // No engine on the page: no tokens, and no complaint either.
    await expect(block.locator('.hljs-keyword')).toHaveCount(0)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
