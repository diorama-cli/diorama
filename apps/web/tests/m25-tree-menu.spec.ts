import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * The file view's context menu (contract.md §36): download, copy the link, open
 * in a browser window — three ways to reach the same file URL, `/~raw~/<path>`
 * (§4).
 *
 * The URL is the point of the feature: every action hands the **file's bytes**
 * to the browser, never the diorama page that shows them.
 */

/** A right-click on one tree row. */
async function openRowMenu(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.locator(`[data-testid="file-tree"] [data-path="${path}"]`).click({ button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
}

test('a file row has a menu with the three actions, and the menu names the file', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="src"]').click()

    await openRowMenu(page, 'src/app.js')
    const menu = page.getByTestId('context-menu')
    // The reader has to know which file they are acting on.
    await expect(menu.locator('.diorama-menu__title')).toHaveText('src/app.js')
    for (const id of ['download', 'copyLink', 'openInWindow']) {
      await expect(menu.locator(`[data-menu-item="${id}"]`)).toBeVisible()
    }

    // Right-clicking is not navigating: no tab opened, URL unchanged.
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(0)
    await expect(page).not.toHaveURL(/~\//)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('the menu closes on Escape and on a press outside it', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)

    await openRowMenu(page, 'README.md')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('context-menu')).toHaveCount(0)

    await openRowMenu(page, 'README.md')
    await page.mouse.click(5, 5)
    await expect(page.getByTestId('context-menu')).toHaveCount(0)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('a directory row keeps the browser menu: only a file has bytes', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.locator('[data-testid="file-tree"] [data-path="src"]').click({ button: 'right' })
    // The page's own menu did not open (the browser's did).
    await expect(page.getByTestId('context-menu')).toHaveCount(0)
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('copying the link copies the raw file URL, not the page URL', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="src"]').click()

    await openRowMenu(page, 'src/app.js')
    await page.locator('[data-menu-item="copyLink"]').click()
    await expect(page.getByTestId('context-menu')).toHaveCount(0)

    const copied = await page.evaluate(() => navigator.clipboard.readText())
    // The file's bytes, on this mount's origin — `/~raw~/`, never `/~/`.
    expect(copied).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/~raw~\/src\/app\.js$/)
    // ...and it really serves the file.
    const response = await page.request.get(copied)
    expect(response.status()).toBe(200)
    expect(await response.text()).toContain('function hi()')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('opening in a window opens the file itself, not the app', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="src"]').click()

    await openRowMenu(page, 'src/app.js')
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('[data-menu-item="openInWindow"]').click(),
    ])
    // A page of its own, showing the raw bytes: the URL says so.
    expect(popup.url()).toMatch(/\/~raw~\/src\/app\.js$/)
    expect(await popup.textContent('body')).toContain('function hi()')
    // The page the reader was on is still the page.
    expect(page.url()).not.toContain('~raw~')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('the raw route answers every source file as text a browser can show', async ({ page }) => {
  // The reported symptom: "many code files open as a download". A type the
  // table did not know was answered as application/octet-stream, which is a
  // save, not a view.
  const directory = fixture({
    'src/app.py': 'print("hi")\n',
    'src/lib.rs': 'fn main() {}\n',
    'src/Main.java': 'class Main {}\n',
    '.gitignore': 'node_modules\n',
    'data.json': '{}\n',
  })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const cases: [string, string][] = [
      ['src/app.py', 'text/x-python; charset=utf-8'],
      ['src/lib.rs', 'text/x-rust; charset=utf-8'],
      ['src/Main.java', 'text/x-java; charset=utf-8'],
      // A dotfile has no extension but is configuration, not a blob.
      ['.gitignore', 'text/plain; charset=utf-8'],
      ['data.json', 'application/json; charset=utf-8'],
      ['README.md', 'text/markdown; charset=utf-8'],
      ['blob.bin', 'application/octet-stream'],
    ]
    for (const [path, type] of cases) {
      const response = await page.request.get(`${server.url}~raw~/${path}`)
      expect(response.status(), path).toBe(200)
      expect(response.headers()['content-type'], path).toBe(type)
      // Inline is the default: only `?download=1` asks for a save.
      expect(response.headers()['content-disposition'], path).toBeUndefined()
    }
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('a UTF-8 file comes back as UTF-8, not as a guess', async ({ page }) => {
  // Without a charset a browser falls back to a locale guess and Chinese text
  // arrives as mojibake — the second reported symptom.
  const directory = fixture({ '说明.md': '# 中文标题\n\n正文\n' })
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const response = await page.request.get(`${server.url}~raw~/%E8%AF%B4%E6%98%8E.md`)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('text/markdown; charset=utf-8')
    expect(await response.text()).toContain('中文标题')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('downloading saves the file, with its own name', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="src"]').click()

    await openRowMenu(page, 'src/app.js')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-menu-item="download"]').click(),
    ])
    expect(download.suggestedFilename()).toBe('app.js')
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString('utf8')).toContain('function hi()')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('the same three actions are commands on the active file', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')

    // No tab: nothing to act on, so the palette does not list them.
    //
    // The palette owns its keys through its **input**, and that input is focused
    // on a `setTimeout(0)` after the overlay opens. So both waits matter:
    // - `toHaveCount(0)` passes instantly against a palette that has not
    //   rendered yet (asserting "not listed" before there is a list);
    // - `Escape` sent before the input has focus reaches nobody, the palette
    //   stays open, and its backdrop swallows the next click.
    const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${MOD}+k`)
    await expect(page.getByTestId('palette')).toBeVisible()
    await expect(page.getByTestId('palette-input')).toBeFocused()
    await expect(page.locator('[data-command="file.download"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('palette')).toHaveCount(0)

    // Open a file: the three commands appear, named after the action.
    await tree.locator('[data-path="docs"]').click()
    await tree.locator('[data-path="docs/notes.md"]').click()
    await page.keyboard.press(`${MOD}+k`)
    for (const id of ['file.download', 'file.copyLink', 'file.openInWindow']) {
      await expect(page.locator(`[data-command="${id}"]`)).toBeVisible()
    }
    await expect(page.locator('[data-command="file.copyLink"]')).toContainText('复制链接')
  } finally {
    await server.stop()
    directory.dispose()
  }
})
