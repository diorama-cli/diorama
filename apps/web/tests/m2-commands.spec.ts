import { expect, test } from '@playwright/test'
import { fixture, startDiorama } from './support.ts'

/**
 * M2 S4 (docs/m2/spec.md §4 row 7, contract.md §3.7): shortcuts run the same
 * command registry the palette will list. `mod` is ⌘ on macOS, Ctrl elsewhere;
 * the key follows the browser's platform, as the kernel parses it.
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openFiles(page: import('@playwright/test').Page, files: string[]): Promise<void> {
  const tree = page.getByTestId('file-tree')
  for (const file of files) await tree.locator(`[data-path="${file}"]`).click()
}

async function activeTabTitle(page: import('@playwright/test').Page): Promise<string | null> {
  return await page.getByTestId('active-tab').getAttribute('title')
}

test('7. shortcuts close, cycle and jump between tabs', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await openFiles(page, ['README.md', 'docs', 'docs/notes.md', 'LICENSE'])
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(3)
    expect(await activeTabTitle(page)).toBe('LICENSE')

    // mod+alt+arrowleft → previous tab (wrapping is not needed here).
    await page.keyboard.press(`${MOD}+Alt+ArrowLeft`)
    expect(await activeTabTitle(page)).toBe('docs/notes.md')
    await page.keyboard.press(`${MOD}+Alt+ArrowRight`)
    expect(await activeTabTitle(page)).toBe('LICENSE')

    // mod+alt+w closes the active tab; its right neighbour (none) → left one.
    await page.keyboard.press(`${MOD}+Alt+W`)
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)
    expect(await activeTabTitle(page)).toBe('docs/notes.md')

    // `ctrl+tab` is a browser-reserved key on macOS (the browser takes it
    // before the page sees it — contract.md §3.7), so the edge commands are
    // driven through the registry here; `mod+alt+arrow*` above already proves
    // the keyboard path.
    const edge = async (command: string): Promise<void> => {
      await page.evaluate(cmd => {
        const kernel = (window as unknown as { __diorama_page__: { getKernel(): { ctx: { commands: { run(id: string): Promise<boolean> } } } } }).__diorama_page__.getKernel()
        void kernel.ctx.commands.run(cmd)
      }, command)
      await page.waitForTimeout(150)
    }
    // Tab order is README.md, docs/notes.md with notes active: forward has
    // nowhere to go (it stops), back reaches README.md (the first), then stops.
    await edge('tabs.nextEdge')
    expect(await activeTabTitle(page)).toBe('docs/notes.md')
    await edge('tabs.prevEdge')
    expect(await activeTabTitle(page)).toBe('README.md')
    await edge('tabs.prevEdge')
    expect(await activeTabTitle(page)).toBe('README.md')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('7b. mod+alt+f focuses the file tree', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await openFiles(page, ['README.md'])
    // Focus leaves the tree (the click put it on a tree row, so move away).
    await page.getByTestId('active-tab').locator('.diorama-tabs__label').click()
    expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="file-tree"]') === null)).toBe(true)
    await page.keyboard.press(`${MOD}+Alt+F`)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid="file-tree"]') !== null))
      .toBe(true)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('7c. shortcuts do not fire while typing in a field', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await openFiles(page, ['README.md', 'LICENSE'])
    // A text field appears with the palette (S5); here a plain input stands in.
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.id = 'probe-input'
      document.body.append(input)
      input.focus()
    })
    await page.keyboard.press(`${MOD}+Alt+W`)
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('7d. the command registry is kernel-provided and shared', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await openFiles(page, ['README.md'])
    const snapshot = await page.evaluate(() => {
      const kernel = (window as unknown as { __diorama_page__: { getKernel(): { ctx: { commands: { getSnapshot(): unknown } } } } }).__diorama_page__.getKernel()
      return kernel.ctx.commands.getSnapshot() as { commands: { id: string }[]; bindings: { keys: string; command: string }[] }
    })
    const ids = snapshot.commands.map(command => command.id)
    for (const id of ['tabs.close', 'tabs.next', 'tabs.prev', 'tabs.nextEdge', 'tabs.prevEdge', 'tree.focus', 'view.refresh', 'view.toggleAutoRefresh']) {
      expect(ids).toContain(id)
    }
    // Bindings are listed for a palette's hints; the tab keys are all present.
    expect(snapshot.bindings.map(binding => binding.keys)).toEqual(
      expect.arrayContaining(['mod+alt+w', 'ctrl+tab', 'ctrl+shift+tab', 'mod+alt+f', 'mod+alt+r']),
    )
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('7e. shortcuts survive macOS Option composition (composed event.key)', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await openFiles(page, ['README.md', 'LICENSE'])
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)

    // Why this test does not use `page.keyboard.press('Meta+Alt+W')`: Chromium's
    // DevTools protocol synthesises the letter, so `key` stays 'w' and the bug
    // hides. A real macOS browser composes Option+W into '∑' (and Option+R into
    // '®', Option+1 into '¡'), which is the event that used to fall through to
    // the browser. Dispatch exactly that, with the physical `code` a real
    // keyboard reports, and require the kernel to consume it.
    const press = async (key: string, code: string): Promise<boolean> =>
      await page.evaluate(([k, c]) => {
        const event = new KeyboardEvent('keydown', {
          key: k, code: c, metaKey: true, altKey: true, bubbles: true, cancelable: true,
        })
        // `dispatchEvent` returns false when a listener called preventDefault:
        // that is the observable "the page took the key" signal.
        return !document.dispatchEvent(event)
      }, [key, code])

    expect(await press('∑', 'KeyW')).toBe(true)
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)

    // ⌘⌥1 is composed as '¡' and switches the sidebar to the files view.
    expect(await press('¡', 'Digit1')).toBe(true)
    await expect(page.getByTestId('sidebar-view').first()).toBeVisible()

    // ⌘⌥R composes to '®': the refresh command exists only with a tab open.
    expect(await press('®', 'KeyR')).toBe(true)
  } finally {
    await server.stop()
    directory.dispose()
  }
})
