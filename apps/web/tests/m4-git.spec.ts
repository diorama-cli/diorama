import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * `ctx.git` over the real channel (docs/m4/spec.md S1, contract.md §3.2): the
 * page's mount handle calls the read-only git service through RPC, and a
 * directory outside a repository simply has no service.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
}

/** Ask the mount's `git` service for status from inside the page. */
async function gitStatusOverRpc(page: Page, url: string): Promise<unknown> {
  await page.goto(url)
  await waitForPage(page)
  return await page.evaluate(async () => {
    const bridge = (window as unknown as {
      __diorama_page__?: {
        getKernel(): { mount: { rpc: { call(method: string, ...args: unknown[]): Promise<unknown> } } } | undefined
      }
    }).__diorama_page__
    const rpc = bridge?.getKernel()?.mount.rpc
    if (rpc === undefined) throw new Error('the page did not boot')
    try {
      return await rpc.call('git.status')
    } catch (error) {
      return `error: ${(error as { code?: string }).code ?? String(error)}`
    }
  })
}

test('git: a repository mount answers status over RPC; a plain directory has no service', async ({ page }) => {
  const repo = fixture()
  const plain = fixture()
  mkdirSync(join(repo.root, 'src'), { recursive: true })
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'LICENSE'), 'changed license\n')
  writeFileSync(join(repo.root, 'fresh.txt'), 'new\n')

  const repoServer = await startDiorama(repo.root)
  const plainServer = await startDiorama(plain.root)
  try {
    const status = (await gitStatusOverRpc(page, repoServer.url)) as { file: string; kind: string }[]
    expect(Array.isArray(status)).toBe(true)
    expect(status.map(entry => `${entry.kind}:${entry.file}`).sort()).toEqual(['modified:LICENSE', 'untracked:fresh.txt'])

    // Not a repository: no `git` service on that mount (ESERVICE, loud).
    expect(await gitStatusOverRpc(page, plainServer.url)).toBe('error: ESERVICE')
  } finally {
    await repoServer.stop()
    await plainServer.stop()
    repo.dispose()
    plain.dispose()
  }
})

test('git: the changes view switches with the tree and opens a file as a diff', async ({ page }) => {
  const repo = fixture()
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'LICENSE'), 'plain text license, changed\n')
  writeFileSync(join(repo.root, 'fresh.txt'), 'brand new\n')
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url)
    // Four views on a repository, `files` first (contract.md §5.2; `history`
    // since v0.6, `search` since v0.8).
    const switcher = page.getByTestId('sidebar-switcher')
    await expect(switcher.getByTestId('sidebar-view')).toHaveCount(4)
    await expect(switcher.locator('[data-view="files"]')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('file-tree')).toBeVisible()

    // Switching shows the changes view; the tree stays mounted but hidden.
    await switcher.locator('[data-view="changes"]').click()
    await expect(switcher.locator('[data-view="changes"]')).toHaveAttribute('aria-selected', 'true')
    const changes = page.getByTestId('git-changes')
    await expect(changes).toBeVisible()
    await expect(changes.locator('[data-path="LICENSE"]')).toBeVisible()
    await expect(changes.locator('[data-path="fresh.txt"]')).toBeVisible()
    await expect(page.getByTestId('file-tree')).toBeHidden()

    // Opening a changed file draws its diff in the tab (contract.md §3.4).
    await changes.locator('[data-path="LICENSE"]').click()
    const active = page.getByTestId('tabs-content').filter({ visible: true })
    const diff = active.getByTestId('git-diff')
    await expect(diff).toBeVisible()
    await expect(diff.locator('[data-testid="git-diff-text"]')).toContainText('+plain text license, changed')
    // An untracked file has no diff: the tab shows its whole content, every
    // line as an addition (contract.md §3.2: the reader reads the file itself).
    await changes.locator('[data-path="fresh.txt"]').click()
    const untracked = page.getByTestId('tabs-content').filter({ visible: true })
    await expect(untracked.getByTestId('git-diff')).toHaveAttribute('data-kind', 'added')
    await expect(untracked.getByTestId('git-diff-notes')).toContainText('新文件')
    const whole = untracked.getByTestId('git-diff-text')
    await expect(whole).toContainText('+brand new')
    // One addition, plus the hunk header the reader numbers it with.
    await expect(whole.locator('[data-tone="add"]')).toHaveCount(1)
    await expect(whole.locator('[data-tone="hunk"]')).toHaveCount(1)

    // Switching back keeps the tree's state (one column, hidden panes).
    await switcher.locator('[data-view="files"]').click()
    await expect(page.getByTestId('file-tree')).toBeVisible()
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('git: content and diff of one file are two tabs; the hash restores the diff', async ({ page }) => {
  const repo = fixture()
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'LICENSE'), 'plain text license, changed\n')
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url)
    await expect(page.getByTestId('sidebar-switcher').getByTestId('sidebar-view')).toHaveCount(4)
    // Content tab first, from the tree.
    await page.getByTestId('file-tree').locator('[data-path="LICENSE"]').click()
    await expect(page).toHaveURL(/\/~\/LICENSE$/)
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(1)

    // The diff of the same file is a second tab (key = (path, view)).
    await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
    await page.getByTestId('git-changes').locator('[data-path="LICENSE"]').click()
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')).toBeVisible()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)
    // The path names the file; the hash only says which view (`#diff`).
    await expect(page).toHaveURL(/\/~\/LICENSE#diff$/)

    // A reload brings both back: the content tab from `/~/`, the diff from `#diff`.
    await page.reload()
    await expect(page.locator('.diorama-tabs__strip [role="tab"]')).toHaveCount(2)
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')).toBeVisible()
    await expect(page.getByTestId('git-diff').locator('[data-testid="git-diff-text"]')).toContainText('+plain text license, changed')

    // Switching to the content tab keeps the file and drops the view flag;
    // switching back to the diff tab puts it back (the flag follows the
    // active tab in both directions).
    await page.locator('.diorama-tabs__strip [role="tab"]').first().locator('.diorama-tabs__label').click()
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).locator('[data-testid="plaintext"]')).toBeVisible()
    await expect(page).toHaveURL(/\/~\/LICENSE$/)
    await page.locator('.diorama-tabs__strip [role="tab"]').nth(1).locator('.diorama-tabs__label').click()
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')).toBeVisible()
    await expect(page).toHaveURL(/\/~\/LICENSE#diff$/)
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('git: the diff can be read inline or inside the whole file, with hunk navigation', async ({ page }) => {
  const repo = fixture()
  // A file long enough to be folded: the change sits in the middle of it.
  const body = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')
  writeFileSync(join(repo.root, 'src/long.js'), body + '\n')
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'src/long.js'), body.replace('line 20', 'line twenty') + '\n')
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url)
    await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
    await page.getByTestId('git-changes').locator('[data-path="src/long.js"]').click()
    const diff = page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')
    await expect(diff).toBeVisible()

    // Inline mode is the default: the unified diff, one row per line, with a
    // gutter of both line numbers.
    await expect(diff).toHaveAttribute('data-mode', 'inline')
    await expect(diff.getByTestId('git-diff-mode-inline')).toHaveAttribute('aria-pressed', 'true')
    const removed = diff.locator('[data-tone="del"]')
    await expect(removed).toHaveCount(1)
    await expect(removed.locator('.diorama-diff__num').first()).toHaveText('20')
    await expect(diff.getByTestId('git-diff-stat')).toContainText('+1')
    await expect(diff.getByTestId('git-diff-stat')).toContainText('−1')

    // The whole file: the real code around the change, and the long runs of
    // unchanged lines folded into one band.
    await diff.getByTestId('git-diff-mode-file').click()
    await expect(diff).toHaveAttribute('data-mode', 'file')
    await expect(diff.getByTestId('git-diff-text')).toHaveAttribute('data-mode', 'file')
    await expect(diff.locator('[data-tone="add"]')).toHaveCount(1)
    await expect(diff.locator('[data-tone="add"]')).toContainText('line twenty')
    await expect(diff.locator('[data-tone="del"]')).toContainText('line 20')
    const gaps = diff.getByTestId('git-diff-gap')
    await expect(gaps).toHaveCount(2)
    // Unchanged lines around the change are real file lines, numbered.
    await expect(diff.getByText('line 19', { exact: true })).toBeVisible()
    // Opening the band above the change shows the lines it was hiding.
    await expect(diff.getByText('line 5', { exact: true })).toHaveCount(0)
    await gaps.first().click()
    await expect(diff.getByText('line 5', { exact: true })).toBeVisible()
    await expect(diff.getByTestId('git-diff-gap')).toHaveCount(1)

    // Side by side: the old file on the left, the new one on the right, the
    // change in both columns — the deletion on the left, the insertion on the
    // right. Unchanged lines are the same text on both sides (one read).
    await diff.getByTestId('git-diff-mode-split').click()
    await expect(diff).toHaveAttribute('data-mode', 'split')
    await expect(diff.getByTestId('git-diff-text')).toHaveAttribute('data-mode', 'split')
    const splitRows = diff.locator('.diorama-diff__split-row')
    await expect(splitRows.filter({ hasText: 'line 19' })).toHaveCount(1)
    // The deleted line is on the left only; its replacement on the right only.
    const changed = splitRows.filter({ hasText: 'line twenty' })
    await expect(changed).toHaveCount(1)
    await expect(changed.locator('[data-tone="del"]')).toContainText('line 20')
    await expect(changed.locator('[data-tone="add"]')).toContainText('line twenty')
    // The band before the change opens here too.
    await diff.getByTestId('git-diff-gap').first().click()
    await expect(splitRows.filter({ hasText: 'line 5' })).toHaveCount(1)

    // The mode is remembered across reloads (it is a reading preference).
    await page.reload()
    const afterReload = page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')
    await expect(afterReload).toHaveAttribute('data-mode', 'split')
    await expect(afterReload.getByTestId('git-diff-mode-split')).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('git: the hunk arrows move between changes, and say where they are', async ({ page }) => {
  const repo = fixture()
  // Two changes far apart: two hunks in one file.
  const body = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
  writeFileSync(join(repo.root, 'src/two.js'), body + '\n')
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'src/two.js'), body.replace('line 10', 'line ten').replace('line 50', 'line fifty') + '\n')
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url)
    await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
    await page.getByTestId('git-changes').locator('[data-path="src/two.js"]').click()
    const diff = page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')
    const count = diff.getByTestId('git-diff-hunk-count')
    await expect(count).toHaveText('2 处改动')

    // Next → 1/2, next → 2/2, next again wraps to the first change.
    await diff.getByTestId('git-diff-next').click()
    await expect(count).toHaveText('1 / 2')
    await diff.getByTestId('git-diff-next').click()
    await expect(count).toHaveText('2 / 2')
    await diff.getByTestId('git-diff-next').click()
    await expect(count).toHaveText('1 / 2')
    // Previous walks back, wrapping too.
    await diff.getByTestId('git-diff-previous').click()
    await expect(count).toHaveText('2 / 2')
    await diff.getByTestId('git-diff-previous').click()
    await expect(count).toHaveText('1 / 2')

    // The whole-file mode has the same two arrows, and the change it picked is
    // in the file's own numbering.
    await diff.getByTestId('git-diff-mode-file').click()
    await diff.getByTestId('git-diff-next').click()
    await expect(diff.locator('[data-tone="add"]')).toHaveCount(2)
    await expect(diff.getByTestId('git-diff-text')).toContainText('line ten')
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('git: the changes view is a tree — directories fold, chains become one row', async ({ page }) => {
  const repo = fixture()
  // A nested change plus a deep single-child chain (which folds to one row).
  mkdirSync(join(repo.root, 'src', 'lib'), { recursive: true })
  mkdirSync(join(repo.root, 'docs'), { recursive: true })
  writeFileSync(join(repo.root, 'src/app.js'), 'const a = 1\n')
  writeFileSync(join(repo.root, 'src/lib/util.ts'), 'export const u = 1\n')
  writeFileSync(join(repo.root, 'docs/a.md'), '# a\n')
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'src/app.js'), 'const a = 2\n')
  writeFileSync(join(repo.root, 'src/lib/util.ts'), 'export const u = 2\n')
  writeFileSync(join(repo.root, 'docs/a.md'), '# a2\n')
  writeFileSync(join(repo.root, 'fresh.txt'), 'new\n')
  const server = await startDiorama(repo.root)
  try {
    await page.goto(server.url)
    await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
    const changes = page.getByTestId('git-changes')
    // Directories first (with their change counts), then root files.
    await expect(changes.locator('[data-path="src"]')).toHaveAttribute('data-kind', 'dir')
    await expect(changes.locator('[data-path="src"]')).toContainText('src/')
    await expect(changes.locator('[data-path="src"]')).toContainText('2')
    // Children are indented under their directory.
    const rootPad = await changes.locator('[data-path="docs"]').evaluate(el => parseInt((el as HTMLElement).style.paddingLeft))
    const filePad = await changes.locator('[data-path="docs/a.md"]').evaluate(el => parseInt((el as HTMLElement).style.paddingLeft))
    expect(filePad).toBeGreaterThan(rootPad)

    // Collapsing a directory hides its subtree; expanding brings it back.
    await changes.locator('[data-path="src"]').click()
    await expect(changes.locator('[data-path="src/app.js"]')).toHaveCount(0)
    await expect(changes.locator('[data-path="src/lib/util.ts"]')).toHaveCount(0)
    await changes.locator('[data-path="src"]').click()
    await expect(changes.locator('[data-path="src/lib/util.ts"]')).toBeVisible()

    // A file in the tree opens its diff, as the flat list did.
    await changes.locator('[data-path="src/lib/util.ts"]').click()
    await expect(page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff-text')).toContainText('+export const u = 2')
    await expect(page).toHaveURL(/\/~\/src\/lib\/util\.ts#diff$/)
  } finally {
    await server.stop()
    repo.dispose()
  }
})
