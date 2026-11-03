// Refresh the README's screenshots against a running diorama instance serving
// this checkout: real source files, diffs and search hits, which the throwaway
// fixtures of the test suite cannot show.
//
// Usage: DIORAMA_URL=http://127.0.0.1:PORT/ node scripts/refresh-readme-shots.mjs
//        [--only tree,changes]   (re-shoot a subset)
import { createRequire } from 'node:module'

// Playwright lives in apps/web's dependency tree; resolve from there.
const { chromium } = createRequire(new URL('../apps/web/package.json', import.meta.url))('@playwright/test')

const base = process.env.DIORAMA_URL
if (base === undefined || base === '') {
  console.error('usage: DIORAMA_URL=http://127.0.0.1:PORT/ node scripts/refresh-readme-shots.mjs')
  process.exit(2)
}

const only = (() => {
  const index = process.argv.indexOf('--only')
  return index === -1 ? undefined : new Set(process.argv[index + 1].split(','))
})()

/** Where the pictures live: the m7 gallery keeps its three, the rest are here. */
const M7 = new URL('../docs/m7/', import.meta.url).pathname
const SHOTS = new URL('../docs/shots/', import.meta.url).pathname

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1180, height: 660 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(20_000)

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Open the mount, optionally with a theme forced through the hash. */
async function open({ theme } = {}) {
  const url = new URL(base)
  url.hash = theme === undefined ? '' : 'theme=' + theme
  await page.goto(url.toString())
  await page.getByTestId('sidebar-switcher').waitFor({ timeout: 15_000 })
}

/** Pick one of the left column's views (they are a click-to-switch switcher). */
async function view(name) {
  await page.getByTestId('sidebar-switcher').locator('[data-view="' + name + '"]').click()
  await page.waitForTimeout(300)
}

/** Expand every directory on the way to `path`, then open the file row. */
async function openInTree(path) {
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) {
    // Only a *collapsed* directory is clicked: clicking an open one folds it
    // shut again, which breaks the second call in a row (two files, one tree).
    const row = page.locator('[data-path="' + parts.slice(0, i).join('/') + '"]').first()
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click()
  }
  await page.locator('[data-path="' + path + '"]').first().click()
  await page.getByTestId('active-tab').first().waitFor({ state: 'visible' })
  await page.waitForTimeout(700)
}

async function shot(file, name) {
  if (only !== undefined && !only.has(name)) return
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  await page.screenshot({ path: file + name + '.png' })
  console.log('wrote', file + name + '.png')
}

// 文件树 — a real source file: line numbers, the toolbar, the status bar.
await open()
await openInTree('packages/kernel/src/server/git.ts')
await shot(M7, 'tree')

// 变更 — a modified file's two-column diff on the right.
await open()
await view('changes')
await page.getByTestId('git-changes').locator('[data-path="README.md"]').first().click()
await page.getByTestId('active-tab').first().waitFor({ state: 'visible' })
await page.waitForTimeout(700)
await shot(M7, 'changes')

// 搜索 — a content search with the hits marked.
await open()
await view('search')
await page.getByTestId('search-input').fill('mountId')
await page.getByTestId('search-results').waitFor()
await page.waitForTimeout(800)
await shot(M7, 'search')

// 历史 — the commit list on the left, the picked commit on the right.
await open()
await view('history')
await page.getByTestId('git-history-commit').first().waitFor()
await page.getByTestId('git-history-commit').first().click()
await page.getByTestId('git-commit').waitFor()
await page.waitForTimeout(600)
await shot(SHOTS, 'history')

// 命令面板 — mod+k, every runnable command with its keys.
await open()
await openInTree('packages/kernel/src/server/git.ts')
await page.keyboard.press(MOD + '+k')
await page.getByTestId('palette').waitFor()
await page.waitForTimeout(400)
await shot(SHOTS, 'palette')
await page.keyboard.press('Escape')

// 速查表 — ? lists every binding.
await open()
await page.keyboard.press('Shift+Slash')
await page.getByTestId('help').waitFor()
await page.waitForTimeout(400)
await shot(SHOTS, 'help')
await page.keyboard.press('Escape')

// 右键菜单 — a file's three actions, all pointing at the raw URL.
await open()
await page.locator('[data-path="README.md"]').first().click({ button: 'right' })
await page.getByTestId('context-menu').waitFor()
await page.waitForTimeout(300)
await shot(SHOTS, 'menu')
await page.keyboard.press('Escape')

// Markdown — the project README rendered: headings, tables, code, and the
// outline rail beside it. The view scrolls to 快速开始 through the outline.
await open()
await openInTree('README.md')
await page.getByTestId('outline').getByText('快速开始', { exact: true }).click()
await page.waitForTimeout(600)
await page.getByTestId('outline').waitFor()
await page.waitForTimeout(600)
await shot(SHOTS, 'markdown')

// 暗色 — the same file view with the dark palette.
await open({ theme: 'dark' })
await openInTree('packages/kernel/src/server/git.ts')
await shot(SHOTS, 'dark')

await browser.close()
