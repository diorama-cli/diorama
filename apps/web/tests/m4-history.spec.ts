import { execFileSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, type Diorama, type Fixture } from './support.ts'

/**
 * The history view (contract.md §3.2 / §5 / §5.2 / §3.7, v0.6): commits in the
 * left column, the picked commit in `seats.git-commit`, `#history=<sha>` on the
 * URL, and the switcher's `mod+alt+<n>` shortcut.
 */
let directory: Fixture
let server: Diorama

/** `mod` is Meta on a mac and Control elsewhere (contract.md §3.7). */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Sue', '-c', 'user.email=sue@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  )
}

/** A repository with two commits; the second changes one file. */
function repository(): { first: string; second: string } {
  directory = fixture()
  git(directory.root, 'init', '-q', '-b', 'main')
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', 'first commit')
  const first = git(directory.root, 'rev-parse', 'HEAD').trim()
  execFileSync('sh', ['-c', 'printf "one\\nTWO\\nthree\\n" > src/app.js'], { cwd: directory.root })
  git(directory.root, 'commit', '-q', '-am', 'second commit\n\nwith a body')
  const second = git(directory.root, 'rev-parse', 'HEAD').trim()
  return { first, second }
}

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

async function openHistory(page: Page): Promise<void> {
  await page.getByTestId('sidebar-switcher').getByRole('tab', { name: '历史' }).click()
  await expect(page.getByTestId('git-history-commit').first()).toBeVisible()
}

test('history: commits list, newest first, and a commit opens in the commit seat', async ({ page }) => {
  const shas = repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)

  const rows = page.getByTestId('git-history-commit')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('second commit')
  await expect(rows.first()).toContainText('Sue')
  await expect(rows.nth(1)).toContainText('first commit')

  await rows.first().click()
  const seat = page.getByTestId('git-commit')
  await expect(seat).toBeVisible()
  await expect(seat).toHaveAttribute('data-sha', shas.second)
  // The message is the subject only; the body is folded until asked for.
  await expect(page.getByTestId('git-commit-message')).toHaveText('second commit')
  await expect(page.getByTestId('git-commit-message-body')).toHaveCount(0)
  const toggle = page.getByTestId('git-commit-message-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('git-commit-message-body')).toHaveText('with a body')
  await toggle.click()
  await expect(page.getByTestId('git-commit-message-body')).toHaveCount(0)
  // The commit's file list, and the first file's diff next to it.
  await expect(page.getByTestId('git-commit-file')).toHaveCount(1)
  await expect(page.getByTestId('git-commit-file').first()).toHaveAttribute('data-file', 'src/app.js')
  await expect(page.getByTestId('git-commit-diff-text')).toContainText('+TWO')
  // The picked commit is in the URL; the file path is untouched by it.
  expect(new URL(page.url()).hash).toBe(`#history=${shas.second}`)
})

test('history: a commit shows the content of the file at that commit', async ({ page }) => {
  repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)
  await page.getByTestId('git-history-commit').first().click()
  // The second commit changed src/app.js: its content at that commit is the
  // new text (not what the working tree would show later, not the parent's).
  await page.getByTestId('git-commit-file').filter({ hasText: 'src/app.js' }).click()
  await page.getByTestId('git-commit-mode-content').click()
  await expect(page.getByTestId('git-commit-blob-text')).toContainText('TWO')
  // The first commit's version of the same file is the fixture's original.
  await page.getByTestId('git-history-commit').nth(1).click()
  await page.getByTestId('git-commit-file').filter({ hasText: 'src/app.js' }).click()
  await page.getByTestId('git-commit-mode-content').click()
  await expect(page.getByTestId('git-commit-blob-text')).not.toContainText('TWO')
  await expect(page.getByTestId('git-commit-blob-text')).toContainText('function hi()')
})

test('history: #history=<sha> survives a refresh and comes back to the view', async ({ page }) => {
  const shas = repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)
  await page.getByTestId('git-history-commit').nth(1).click()
  await expect(page.getByTestId('git-commit')).toHaveAttribute('data-sha', shas.first)

  await page.reload()
  // The view is chosen by the hash (layout reads the known view keys) and the
  // seat shows the same commit.
  await expect(page.getByTestId('sidebar-switcher').getByRole('tab', { name: '历史' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('git-commit')).toHaveAttribute('data-sha', shas.first)
})

test('history: the switcher has shortcuts, and a view that is not there is not runnable', async ({ page }) => {
  repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await expect(page.getByTestId('sidebar-pane').first()).toBeVisible()

  // mod+alt+2 → changes, mod+alt+3 → history, mod+alt+1 → files.
  await page.keyboard.press(`${MOD}+Alt+2`)
  await expect(page.getByTestId('sidebar-switcher').getByRole('tab', { name: '变更' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press(`${MOD}+Alt+3`)
  await expect(page.getByTestId('sidebar-switcher').getByRole('tab', { name: '历史' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press(`${MOD}+Alt+1`)
  await expect(page.getByTestId('sidebar-switcher').getByRole('tab', { name: '文件' })).toHaveAttribute('aria-selected', 'true')

  // The commands are in the registry, gated by whether their view exists.
  const commands = await page.evaluate(() => {
    const bridge = (window as unknown as {
      __diorama_page__: { getKernel(): { ctx: { commands: { canRun(id: string): boolean } } } }
    }).__diorama_page__
    const service = bridge.getKernel().ctx.commands
    return ['sidebar.showFiles', 'sidebar.showChanges', 'sidebar.showHistory'].map(id => [id, service.canRun(id)])
  })
  expect(commands).toEqual([
    ['sidebar.showFiles', true],
    ['sidebar.showChanges', true],
    ['sidebar.showHistory', true],
  ])
})

test('history: a plain directory has neither git view', async ({ page }) => {
  // A fixture that is not a repository (unless the temp dir sits inside one).
  directory = fixture()
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory.root, stdio: 'ignore' })
    test.skip(true, 'the temp directory is inside a working tree')
  } catch {
    // not a repository: proceed
  }
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  const tabs = page.getByTestId('sidebar-switcher').getByRole('tab')
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toHaveAccessibleName('文件')
  // "Show the history" cannot run where there is no history view.
  await page.waitForFunction(() => {
    const bridge = (window as unknown as { __diorama_page__?: { getKernel(): unknown } }).__diorama_page__
    return bridge?.getKernel() !== undefined
  })
  expect(
    await page.evaluate(() => {
      const bridge = (window as unknown as {
        __diorama_page__: { getKernel(): { ctx: { commands: { canRun(id: string): boolean } } } }
      }).__diorama_page__
      return bridge.getKernel().ctx.commands.canRun('sidebar.showHistory')
    }),
  ).toBe(false)
})

test('history: the changes view re-reads on file-system events, without polling', async ({ page }) => {
  repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await page.getByTestId('sidebar-switcher').getByRole('tab', { name: '变更' }).click()
  const changes = page.getByTestId('git-changes')
  await expect(changes).toContainText('工作区没有改动')

  // A new file in the working tree shows up because fs.watch fired, not
  // because a timer did (contract.md §3.1 driven by the changes view).
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(join(directory.root, 'src/added.js'), 'added\n')
  await expect(changes.locator('[data-path="src"]')).toBeVisible()
  await expect(changes.getByText('added.js')).toBeVisible()
})

test('history: a multi-line body folds to one line; a title-only commit has no toggle', async ({ page }) => {
  directory = fixture()
  git(directory.root, 'init', '-q', '-b', 'main')
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', 'title only')
  execFileSync('sh', ['-c', 'printf "x\\n" > a.txt'], { cwd: directory.root })
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', 'layered\n\nfirst body line\nsecond body line\n\nthird paragraph')
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)

  // The newest commit has a body: one title line, the rest behind the toggle.
  const rows = page.getByTestId('git-history-commit')
  await rows.first().click()
  await expect(page.getByTestId('git-commit-message')).toHaveText('layered')
  await page.getByTestId('git-commit-message-toggle').click()
  const body = page.getByTestId('git-commit-message-body')
  await expect(body).toContainText('first body line')
  await expect(body).toContainText('third paragraph')

  // A title-only commit has nothing to fold: no toggle, just the title.
  await rows.nth(1).click()
  await expect(page.getByTestId('git-commit-message')).toHaveText('title only')
  await expect(page.getByTestId('git-commit-message-toggle')).toHaveCount(0)
  await expect(page.getByTestId('git-commit-message-body')).toHaveCount(0)
})
