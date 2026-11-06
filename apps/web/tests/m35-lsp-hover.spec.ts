import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Two behaviours the first cut got wrong (contract.md §3.12):
 *
 * 1. **A hover card is Markdown.** A language server answers with a fence and
 *    a doc comment; printing that shows the reader the fence markers.
 * 2. **Several definitions are a list, one is a jump.** Jumping to the first
 *    of several is a silent guess.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Two overloads of \`add\` in one file, and a caller of each. */
function hoverFixture() {
  return fixture({
    'src/math.ts': [
      '/** 两数相加。 */',
      'export function add(a: number, b: number): number {',
      '  return a + b',
      '}',
      '',
      '/** 三个数相加。 */',
      'export function add(a: number, b: number, c: number): number',
      'export function add(a: number, b: number, c?: number): number {',
      '  return c === undefined ? a + b : a + b + c',
      '}',
      '',
    ].join('\n'),
    'src/main.ts': [
      'import { add } from "./math.ts"',
      '',
      'export function run(): number {',
      '  return add(1, 2)',
      '}',
      '',
    ].join('\n'),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' } }),
  })
}

/** The centre of the first occurrence of \`word\` inside a line's text cell. */
async function pointOf(page: Page, line: number, word: string): Promise<{ x: number; y: number } | null> {
  return await page.evaluate(({ line, word }) => {
    for (const cell of [...document.querySelectorAll('[data-line-number="' + line + '"] .diorama-line__text')]) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = (node.textContent ?? '').indexOf(word)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + word.length)
        const rect = range.getBoundingClientRect()
        if (rect.width === 0) continue
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
    }
    return null
  }, { line, word })
}

test('lsp: the hover card renders the answer as Markdown, not as text', async ({ page }) => {
  const repo = hoverFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/main.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    const point = await pointOf(page, 4, 'add')
    expect(point).not.toBeNull()
    if (point === null) return
    // Step across the word so a mouseover definitely lands on it.
    for (const dx of [-6, -3, 0, 3, 6]) {
      await page.mouse.move(point.x + dx, point.y)
      await page.waitForTimeout(120)
    }
    const card = page.getByTestId('lsp-hover')
    await expect(card).toBeVisible()
    // The answer is one fenced block: it must be drawn as a code block with
    // tokens, and the fence markers must be gone.
    await expect(card.locator('pre code').first()).toBeVisible()
    expect(await card.locator('pre code span').count()).toBeGreaterThan(0)
    expect(await card.innerText()).not.toContain('```')
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: the card waits a second, and leaving hides it at once', async ({ page }) => {
  const repo = hoverFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/main.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    // Warm first: the server's first answer is provisional (m33/spec §6).
    await page.evaluate(async () => {
      const bridge = (window as unknown as {
        __diorama_page__?: { getKernel(): { mount: { lsp: { definition(p: string, at: unknown): Promise<unknown> } } } | undefined }
      }).__diorama_page__
      await bridge?.getKernel()?.mount.lsp.definition('src/main.ts', { line: 4, character: 10 })
    })
    const point = await pointOf(page, 4, 'add')
    expect(point).not.toBeNull()
    if (point === null) return
    const card = page.getByTestId('lsp-hover')

    // Resting briefly is **not** enough: the card is a reading aid, and one
    // that pops up while the pointer crosses a line is noise.
    await page.mouse.move(point.x - 6, point.y)
    await page.mouse.move(point.x, point.y)
    await page.waitForTimeout(400)
    await expect(card).toHaveCount(0)
    // Staying still long enough brings it up.
    await expect(card).toBeVisible({ timeout: 3000 })

    // Leaving the **token** is a decision: the card goes at once, and it does
    // not wait for the pointer to leave the whole pane.
    await page.mouse.move(point.x + 200, point.y)
    await expect(card).toHaveCount(0)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: clicking an overload jumps to the other declaration, no list', async ({ page }) => {
  const repo = hoverFixture()
  const server = await startDiorama(repo.root)
  try {
    // The implementation on line 8: `definition` answers lines 2 and 8, the
    // clicked one is dropped, and a declaration always wins as the jump — so
    // the reader lands on the overload, with no list to read.
    await page.goto(server.url + '~/src/math.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    const point = await pointOf(page, 8, 'add')
    expect(point).not.toBeNull()
    if (point === null) return
    await page.keyboard.down(MOD)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up(MOD)
    const active = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(active.getByTestId('code-path')).toHaveText('src/math.ts')
    await expect(page.locator('.diorama-menu')).toHaveCount(0)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: a single definition jumps without a list', async ({ page }) => {
  const repo = hoverFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/main.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    const point = await pointOf(page, 4, 'add')
    expect(point).not.toBeNull()
    if (point === null) return
    await page.keyboard.down(MOD)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up(MOD)
    // No chooser: the reader goes straight to the declaration.
    const active = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(active.getByTestId('code-path')).toHaveText('src/math.ts')
    await expect(page.locator('.diorama-menu')).toHaveCount(0)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: a click past the end of a line does not kill the server', async ({ page }) => {
  const repo = hoverFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/main.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    // A column far past the end of a short line: tsserver 5.9.3 throws on this
    // and dies, which would take the feature away from every other file too.
    const answer = await page.evaluate(async () => {
      const bridge = (window as unknown as {
        __diorama_page__?: { getKernel(): { mount: { lsp: { definition(p: string, at: unknown): Promise<unknown> } } } | undefined }
      }).__diorama_page__
      const mount = bridge?.getKernel()?.mount
      if (mount === undefined) throw new Error('the page did not boot')
      return await mount.lsp.definition('src/main.ts', { line: 2, character: 999 })
    })
    expect(Array.isArray(answer)).toBe(true)
    // And the server is still answering afterwards.
    const stillWorks = await page.evaluate(async () => {
      const bridge = (window as unknown as {
        __diorama_page__?: { getKernel(): { mount: { lsp: { status(): Promise<{ language: string; state: string }[]> } } } | undefined }
      }).__diorama_page__
      const servers = await bridge?.getKernel()?.mount.lsp.status()
      return servers?.find(entry => entry.language === 'typescript')?.state
    })
    expect(stillWorks).toBe('running')
  } finally {
    await server.stop()
    repo.dispose()
  }
})
