import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Language intelligence (contract.md §3.12, docs/m33/spec.md).
 *
 * Two things are checked here:
 *
 * 1. the **service** answers over RPC — a real language server, spawned per
 *    mount, resolving a symbol to the line it is declared on;
 * 2. the **gesture** is wired — a ⌘/Ctrl+click on a row opens the file the
 *    definition lives in and flashes the line, using the same reveal store a
 *    search hit uses.
 *
 * The TypeScript server is the one every JS/TS reader has; when it is not
 * installed the service installs it into `/tmp/diorama/.cache/lsp` on first
 * use, which is why the first test allows a longer timeout.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Two files where the second declares what the first uses. */
function tsFixture() {
  return fixture({
    'src/math.ts': ['export function add(a: number, b: number): number {', '  return a + b', '}', ''].join('\n'),
    'src/main.ts': ['import { add } from "./math.ts"', '', 'const total = add(1, 2)', 'console.log(total)', ''].join('\n'),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' } }),
  })
}

/** Ask the page's own `mountCtx.lsp` something, through RPC. */
async function lspCall<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return await page.evaluate(
    async ({ method, args }) => {
      const bridge = (window as unknown as {
        __diorama_page__?: { getKernel(): { mount: { lsp: Record<string, (...params: unknown[]) => Promise<unknown>> } } | undefined }
      }).__diorama_page__
      const mount = bridge?.getKernel()?.mount
      if (mount === undefined) throw new Error('the page did not boot')
      const fn = mount.lsp[method]
      if (fn === undefined) throw new Error('no lsp.' + method)
      return await fn.apply(mount.lsp, args)
    },
    { method, args },
  ) as T
}

test('lsp: a definition is answered for a real file, 1-based like the gutter', async ({ page }) => {
  const repo = tsFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    // The service exists on every mount (contract.md §3.12).
    const status = await lspCall<{ language: string; state: string }[]>(page, 'status')
    expect(status.map(server => server.language)).toContain('typescript')

    // `add` is used on line 3 of main.ts and declared on line 1 of math.ts.
    const locations = await lspCall<{ path: string; range: { start: { line: number } } }[]>(page, 'definition', 'src/main.ts', {
      line: 3,
      character: 14,
    })
    expect(locations.length).toBeGreaterThan(0)
    expect(locations[0]?.path).toBe('src/math.ts')
    // 1-based on the wire: the declaration is the file's first line.
    expect(locations[0]?.range.start.line).toBe(1)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: ⌘/Ctrl+click on a symbol opens the file that declares it', async ({ page }) => {
  const repo = tsFixture()
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url + '~/src/main.ts')
    const code = page.getByTestId('code')
    await expect(code).toBeVisible()
    await waitForPage(page)

    // The word `add` on line 3, inside the renderer's own row. It is measured
    // with a `Range` over its own text node: the line starts with `const`, so a
    // fixed offset would land on the wrong identifier.
    const row = code.locator('[data-line-number="3"]')
    await expect(row).toBeVisible()
    const point = await page.evaluate(() => {
      const cell = document.querySelector('[data-line-number="3"] .diorama-line__text')
      if (cell === null) return null
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = (node.textContent ?? '').indexOf('add')
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 3)
        const rect = range.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
      return null
    })
    expect(point).not.toBeNull()
    if (point === null) return
    await page.keyboard.down(MOD)
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up(MOD)

    // The jump lands in math.ts and flashes the declaration line. Every open
    // tab keeps its renderer mounted (contract.md §3.4), so the assertion is
    // scoped to the visible seat.
    const active = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(active.getByTestId('code-path')).toHaveText('src/math.ts')
    await expect(active.getByTestId('code-reveal').first()).toBeVisible()
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('lsp: without the lsp-nav piece there is no hover card and no jump', async ({ page }) => {
  const repo = tsFixture()
  const server = await startDiorama(repo.root, ['--plugins', 'slots,layout,file-tree,tabs,renderer-registry,plaintext,markdown,code'])
  try {
    await page.goto(server.url + '~/src/main.ts')
    await expect(page.getByTestId('code')).toBeVisible()
    await waitForPage(page)
    // The page-global face the renderer asks for is empty: the store object is
    // created by the first subscriber, but nobody published into it (§8).
    const face = await page.evaluate(
      () => (globalThis as unknown as { __diorama_lsp_nav__?: { current?: unknown } }).__diorama_lsp_nav__?.current,
    )
    expect(face).toBeUndefined()
    await expect(page.getByTestId('lsp-hover')).toHaveCount(0)
  } finally {
    await server.stop()
    repo.dispose()
  }
})
