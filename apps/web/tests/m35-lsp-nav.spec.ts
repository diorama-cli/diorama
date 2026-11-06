import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * The direction of a click, and the cue that says it is clickable
 * (contract.md §3.12).
 *
 * A definition answer alone cannot drive this gesture: clicking a **usage**
 * must go to the declaration, and clicking a **declaration** must offer the
 * usages — which only exists if the references answer is merged in. The first
 * cut asked for definitions only, so a declaration click answered "you are
 * already here" and highlighted itself.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** \`multiply\` is declared once and used twice, in another file. */
function navFixture() {
  return fixture({
    'src/math.ts': [
      'export function multiply(a: number, b: number): number {',
      '  return a * b',
      '}',
      '',
    ].join('\n'),
    'src/main.ts': [
      'import { multiply } from "./math.ts"',
      '',
      'export function run(): number {',
      '  return multiply(2, 3)',
      '}',
      '',
      'export function total(): number {',
      '  return multiply(4, 5)',
      '}',
      '',
    ].join('\n'),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' } }),
  })
}

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

/** Warm the language server: its first answer is provisional (see m33/spec §6). */
async function warm(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bridge = (window as unknown as {
      __diorama_page__?: { getKernel(): { mount: { lsp: { definition(p: string, at: unknown): Promise<unknown> } } } | undefined }
    }).__diorama_page__
    const mount = bridge?.getKernel()?.mount
    if (mount === undefined) throw new Error('the page did not boot')
    await mount.lsp.definition('src/math.ts', { line: 1, character: 17 })
  })
}

test('lsp: clicking a declaration lists the places that use it', async ({ page }) => {
  const repo = navFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/math.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    await warm(page)
    const point = await pointOf(page, 1, 'multiply')
    expect(point).not.toBeNull()
    if (point === null) return
    await page.keyboard.down(MOD)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up(MOD)
    const menu = page.locator('.diorama-menu')
    await expect(menu).toBeVisible()
    // Every usage, labelled as such — and **not** the declaration itself.
    // tsserver counts the `import` line as a usage too, so there are three.
    const items = menu.locator('.diorama-menu__item')
    await expect(items).toHaveCount(3)
    // Rows read as path:line — no "definition" / "usage" prefix in front of
    // the only thing that differs.
    for (const text of await items.allInnerTexts()) expect(text).toMatch(/^src\/main\.ts:\d+$/)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: clicking a usage goes straight to the declaration', async ({ page }) => {
  const repo = navFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/main.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    await warm(page)
    const point = await pointOf(page, 4, 'multiply')
    expect(point).not.toBeNull()
    if (point === null) return
    await page.keyboard.down(MOD)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up(MOD)
    // No list: the declaration is the answer to "where does this live".
    const active = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(active.getByTestId('code-path')).toHaveText('src/math.ts')
    await expect(page.locator('.diorama-menu')).toHaveCount(0)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: holding ⌘ takes the hover card down', async ({ page }) => {
  const repo = navFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/main.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    await warm(page)
    const point = await pointOf(page, 4, 'multiply')
    expect(point).not.toBeNull()
    if (point === null) return
    // Rest on the word until the card is up.
    await page.mouse.move(point.x - 6, point.y)
    await page.mouse.move(point.x, point.y)
    const card = page.getByTestId('lsp-hover')
    await expect(card).toBeVisible()
    // Holding ⌘ puts it away: it sits at the pointer, and so does the list a
    // click opens — a card left up covers the rows the reader is picking.
    await page.keyboard.down(MOD)
    await expect(card).toHaveCount(0)
    await page.keyboard.up(MOD)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: holding ⌘ underlines the identifier a click would act on', async ({ page }) => {
  const repo = navFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/main.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    const point = await pointOf(page, 4, 'multiply')
    expect(point).not.toBeNull()
    if (point === null) return
    // **Rest on the word first, then press the modifier.** No pointer event
    // fires on the key press, so the underline has to be worked out from where
    // the pointer already is (contract.md §3.12).
    await page.mouse.move(point.x - 5, point.y)
    await page.mouse.move(point.x, point.y)
    await page.waitForTimeout(120)
    await page.keyboard.down(MOD)
    const underline = page.getByTestId('lsp-link')
    await expect(underline).toBeVisible()
    // It is under the **word**, not the row: narrower than the pane.
    const box = await underline.boundingBox()
    expect(box).not.toBeNull()
    if (box !== null) expect(box.width).toBeGreaterThan(10)
    // The token says "clickable" with the pointer, not just the band.
    const cursor = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y)
      return element === null ? 'none' : getComputedStyle(element).cursor
    }, point)
    expect(cursor).toBe('pointer')
    // Releasing the modifier takes it down — and the cursor with it: no mouse
    // event fires on release, so both are cleared from the hold state.
    await page.keyboard.up(MOD)
    await expect(underline).toHaveCount(0)
    await expect
      .poll(async () =>
        page.evaluate(({ x, y }) => {
          const element = document.elementFromPoint(x, y)
          return element === null ? 'none' : getComputedStyle(element).cursor
        }, point),
      )
      .not.toBe('pointer')
  } finally {
    await server.stop()
    repo.dispose()
  }
})
