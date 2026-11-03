import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage, type Diorama, type Fixture } from './support.ts'

/**
 * The status bar (contract.md §5.4): a piece fills a `layout.status` seat that
 * `layout` declares and draws under the frame.
 *
 * - it says which **instance** this page is (directory, mount id, origin);
 * - it says what **file** the active tab holds (path, size, lines, mtime), and
 *   whether that tab shows the file or its working-tree diff;
 * - it is **optional**: a page whose plugin selection leaves the piece out has
 *   no bar at all, and the frame is exactly what it was;
 * - it costs the frame nothing: the bar takes its own height, the window does
 *   not start scrolling.
 */

let directory: Fixture
let server: Diorama

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
}

test('status bar: the instance, and the file the active tab holds', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await waitForPage(page)

  const bar = page.getByTestId('status-bar')
  await expect(bar).toBeVisible()
  // The instance: the **whole** served path (contract.md §5.4 — three checkouts
  // can all be called `diorama`), then the mount id the CLI prints as
  // `[mount:…]`.
  await expect(page.getByTestId('status-mount')).toHaveText(directory.realRoot)
  // The last segment is the one that keeps its contrast and its width.
  await expect(page.locator('.diorama-statusbar__root-name')).toHaveText(
    directory.realRoot.slice(directory.realRoot.lastIndexOf('/') + 1),
  )
  await expect(page.locator('.diorama-statusbar__root-parent')).toHaveText(
    directory.realRoot.slice(0, directory.realRoot.lastIndexOf('/') + 1),
  )
  await expect(page.getByTestId('status-mount-id')).toHaveText(/^[0-9a-f]{8}$/)
  await expect(page.getByTestId('status-origin')).toContainText(`:${server.port}`)
  // Nothing open yet: the file cell says so instead of staying blank.
  await expect(page.getByTestId('status-file')).toHaveText('未打开文件')

  await page.locator('[data-path="README.md"]').click()
  await expect(page.getByTestId('status-file')).toHaveText('README.md')
  // `# Readme\n\n- first\n- second\n` — four lines by the readers' count.
  await expect(page.getByTestId('status-lines')).toHaveText('4 行')
  await expect(page.getByTestId('status-size')).toHaveText(/\d+ 字节/)
  await expect(page.getByTestId('status-mtime')).not.toBeEmpty()
})

test('status bar: a diff tab says so', async ({ page }) => {
  directory = fixture()
  git(directory.root, 'init', '-q', '-b', 'main')
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(directory.root, 'LICENSE'), 'plain text license, changed\n')
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await waitForPage(page)
  await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
  const changes = page.getByTestId('git-changes')
  await expect(changes.locator('[data-path="LICENSE"]')).toBeVisible()
  await changes.locator('[data-path="LICENSE"]').click()
  // The changes view opens a tab with `view: 'diff'` (contract.md §3.4).
  await expect(page.getByTestId('status-file')).toHaveText('LICENSE')
  await expect(page.getByTestId('status-view')).toHaveText('差异')
})

test('status bar: a page without the piece has no bar', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root, ['--plugins', 'slots,layout,file-tree,tabs,renderer-registry,plaintext'])
  await page.goto(server.url)
  await waitForPage(page)
  await expect(page.getByTestId('status-bar')).toHaveCount(0)
  // The seat is still declared (layout owns it) but empty, so no footer.
  await expect(page.locator('[data-slot="layout.status"]')).toHaveCount(0)
})

test('status bar: the bar is under the frame and the window does not scroll', async ({ page }) => {
  directory = fixture()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await waitForPage(page)
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('.diorama-statusbar') as HTMLElement | null
    const frame = document.querySelector('[data-layout]') as HTMLElement | null
    if (bar === null || frame === null) throw new Error('the bar or the frame is missing')
    return {
      barTop: Math.round(bar.getBoundingClientRect().top),
      barHeight: Math.round(bar.getBoundingClientRect().height),
      frameBottom: Math.round(frame.getBoundingClientRect().bottom),
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }
  })
  // The bar is below the frame, not on top of it.
  expect(geometry.barTop).toBeGreaterThanOrEqual(geometry.frameBottom - 1)
  expect(geometry.barHeight).toBeGreaterThan(0)
  // Adding the bar must not make the page scroll: the frame gives up the height.
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.innerHeight + 1)
})
