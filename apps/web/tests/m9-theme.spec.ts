import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Theme switching (contract.md §3.10): the page follows the OS by default, an
 * explicit choice sticks (and survives a reload), the choice travels in the URL
 * hash, and a piece can add a theme without the kernel or `diorama-ui` knowing
 * its name.
 *
 * The colours are read from the computed style of `body`, so the assertions are
 * about the palette actually applied, not about attributes.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** The page's background colour as the browser computed it. */
async function background(page: import('@playwright/test').Page): Promise<string> {
  return await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
}

/** The scheme attribute the kernel (or the pre-paint bootstrap) wrote. */
async function scheme(page: import('@playwright/test').Page): Promise<string | null> {
  return await page.evaluate(() => document.documentElement.getAttribute('data-scheme'))
}

test('1. with no choice the page follows the OS, and follows it live', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(server.url)
    await waitForPage(page)
    expect(await scheme(page)).toBe('dark')
    // The dark palette really is the one painted (not just an attribute).
    expect(await background(page)).toBe('rgb(22, 24, 29)')

    // The OS switching over repaints the page with no user action.
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => scheme(page)).toBe('light')
    expect(await background(page)).toBe('rgb(255, 255, 255)')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('2. an explicit choice wins over the OS, survives a reload, and lives in the URL', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(server.url)
    await waitForPage(page)
    expect(await scheme(page)).toBe('light')

    // The palette runs the command like any other (contract.md §3.7).
    await page.keyboard.press(`${MOD}+k`)
    await page.getByTestId('palette-input').fill('主题：暗色')
    await page.locator('[data-command="theme.useDark"]').click()
    await expect(page.getByTestId('palette')).toHaveCount(0)
    expect(await scheme(page)).toBe('dark')
    expect(await background(page)).toBe('rgb(22, 24, 29)')
    // `#theme=dark`: the choice is shareable (contract.md §3.8).
    expect(new URL(page.url()).hash).toBe('#theme=dark')

    // A reload keeps it even though the OS still says light.
    await page.reload()
    await waitForPage(page)
    expect(await scheme(page)).toBe('dark')
    expect(await background(page)).toBe('rgb(22, 24, 29)')

    // The OS flipping to dark does not move a pinned scheme.
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.emulateMedia({ colorScheme: 'light' })
    expect(await scheme(page)).toBe('dark')

    // "Follow the system" clears the hash entry rather than writing a value.
    await page.keyboard.press(`${MOD}+k`)
    await page.getByTestId('palette-input').fill('主题：跟随系统')
    await page.locator('[data-command="theme.useSystem"]').click()
    await expect.poll(() => scheme(page)).toBe('light')
    expect(new URL(page.url()).hash).toBe('')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('3. mod+alt+t cycles system → light → dark → system', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto(server.url)
    await waitForPage(page)
    expect(await scheme(page)).toBe('light')

    // system → light (no visual change with a light OS, but now pinned).
    await page.keyboard.press(`${MOD}+Alt+t`)
    expect(await scheme(page)).toBe('light')
    expect(new URL(page.url()).hash).toBe('#theme=light')
    // light → dark.
    await page.keyboard.press(`${MOD}+Alt+t`)
    await expect.poll(() => scheme(page)).toBe('dark')
    expect(new URL(page.url()).hash).toBe('#theme=dark')
    // dark → system: back to following the OS, and the hash entry goes away.
    await page.keyboard.press(`${MOD}+Alt+t`)
    await expect.poll(() => scheme(page)).toBe('light')
    expect(new URL(page.url()).hash).toBe('')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('4. a shared #theme=dark link paints dark before the bundle runs', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.emulateMedia({ colorScheme: 'light' })
    // The bootstrap in index.html resolves the remembered scheme (written by a
    // previous paint) or the OS — a shared link is resolved by the service once
    // it boots, and the page never flashes the wrong palette in between.
    await page.goto(`${server.url}#theme=dark`)
    await waitForPage(page)
    expect(await scheme(page)).toBe('dark')
    expect(await background(page)).toBe('rgb(22, 24, 29)')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('5. a piece can register a theme; it becomes a command and recolours the page', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)

    // A third-party theme is data: tokens over the built-in palette, no CSS
    // file and no code in the kernel or `diorama-ui` knows its name.
    await page.evaluate(() => {
      const kernel = (window as unknown as {
        __diorama_page__: { getKernel(): { ctx: { theme: { register(theme: unknown): void } } } }
      }).__diorama_page__.getKernel()
      kernel.ctx.theme.register({
        id: 'demo-solarized',
        title: 'Solarized',
        scheme: 'light',
        tokens: { '--dio-bg': '#fdf6e3', '--dio-panel': '#eee8d5' },
      })
    })

    // The `theme` piece turns every registered theme into a palette row.
    await page.keyboard.press(`${MOD}+k`)
    await page.getByTestId('palette-input').fill('Solarized')
    await expect(page.locator('[data-command="theme.use:demo-solarized"]')).toBeVisible()
    await page.locator('[data-command="theme.use:demo-solarized"]').click()

    expect(await scheme(page)).toBe('light')
    expect(await background(page)).toBe('rgb(253, 246, 227)')
    // The token the theme did not override still comes from the palette.
    const border = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--dio-border').trim(),
    )
    expect(border).toBe('#e3e3e6')
    expect(new URL(page.url()).hash).toBe('#theme=demo-solarized')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
