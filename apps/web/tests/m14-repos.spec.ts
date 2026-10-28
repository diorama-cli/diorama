import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * Several repositories under one mount (contract.md §3.2, v0.10): the changes
 * and history views group them, the groups fold, and a nested repository does
 * not leak into its parent's list.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
}

/** A committed repository at dir, with one change in the working tree. */
function repoAt(dir: string, file = 'file.txt'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), 'one\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  writeFileSync(join(dir, file), 'one\ntwo\n')
}

/** repos() from inside the page. */
async function reposOverRpc(page: Page, url: string): Promise<unknown> {
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
    return await rpc.call('git.repos')
  })
}

test('git: a mount holding several repositories lists them all', async ({ page }) => {
  const root = fixture()
  repoAt(join(root.root, 'apps', 'api'))
  repoAt(join(root.root, 'apps', 'web'))
  const server = await startDiorama(root.root)
  try {
    const repos = (await reposOverRpc(page, server.url)) as { path: string }[]
    expect(repos.map(repo => repo.path).sort()).toEqual(['apps/api', 'apps/web'])
  } finally {
    await server.stop()
    root.dispose()
  }
})

test('git: the changes view groups by repository, and a group folds', async ({ page }) => {
  const root = fixture()
  repoAt(join(root.root, 'apps', 'api'), 'a.txt')
  repoAt(join(root.root, 'apps', 'web'), 'b.txt')
  const server = await startDiorama(root.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
    const groups = page.getByTestId('git-changes-repo')
    await expect(groups).toHaveCount(2)
    await expect(groups.first()).toContainText('apps/api')
    await expect(groups.first()).toContainText('a.txt')
    await expect(groups.nth(1)).toContainText('apps/web')
    const head = groups.first().locator('.diorama-changes__repo-head')
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await head.click()
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await expect(groups.first()).not.toContainText('a.txt')
    await head.click()
    await expect(groups.first()).toContainText('a.txt')
  } finally {
    await server.stop()
    root.dispose()
  }
})

test('git: a nested repository is its own group, not part of the outer one', async ({ page }) => {
  const root = fixture()
  const outer = join(root.root, 'outer')
  repoAt(outer, 'outer.txt')
  repoAt(join(outer, 'vendor', 'lib'), 'inner.txt')
  const server = await startDiorama(root.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
    const groups = page.getByTestId('git-changes-repo')
    await expect(groups).toHaveCount(2)
    const outerGroup = groups.filter({ hasText: 'outer' }).first()
    await expect(outerGroup).toContainText('outer.txt')
    await expect(outerGroup).not.toContainText('inner.txt')
    const innerGroup = groups.filter({ hasText: 'vendor/lib' }).first()
    await expect(innerGroup).toContainText('inner.txt')
  } finally {
    await server.stop()
    root.dispose()
  }
})

test('git: the history view switches between repositories with a picker', async ({ page }) => {
  const root = fixture()
  repoAt(join(root.root, 'apps', 'api'))
  repoAt(join(root.root, 'apps', 'web'))
  const server = await startDiorama(root.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('sidebar-switcher').locator('[data-view="history"]').click()
    // One repository on show at a time (v0.19): the picker chooses which, and
    // the column holds that repository's commits alone.
    const shown = page.getByTestId('git-history-repo')
    await expect(shown).toHaveCount(1)
    await expect(shown).toHaveAttribute('data-repo', 'apps/api')
    await expect(page.getByTestId('git-history-commit')).toHaveCount(1)
    const picker = page.getByTestId('git-history-picker')
    await expect(picker).toBeVisible()
    // The picker is one control: its glyph sits **inside** the same row, on the
    // same line, and the row floats over the list (sticky + a shadow). These are
    // computed styles, so a stale page shell — which ships the CSS — fails here
    // rather than looking subtly wrong in a screenshot (see AGENTS §3).
    const row = page.locator('.diorama-changes__picker')
    const layout = await row.evaluate(element => {
      const style = getComputedStyle(element)
      const icon = element.querySelector('.diorama-file-icon')
      const box = element.querySelector('select')
      const borderBox = element.querySelector('.diorama-changes__selectbox')
      const boxStyle = borderBox === null ? undefined : getComputedStyle(borderBox)
      const selectStyle = box === null ? undefined : getComputedStyle(box)
      const iconBox = icon?.getBoundingClientRect()
      const boxBox = box?.getBoundingClientRect()
      const borderBoxBox = borderBox?.getBoundingClientRect()
      return {
        position: style.position,
        shadow: style.boxShadow,
        background: style.backgroundColor,
        // The box the reader sees is the label's; the select inside it draws no
        // border of its own (so the glyph is *in* that box, not beside it).
        boxBorder: boxStyle?.borderTopWidth,
        boxBackground: boxStyle?.backgroundColor,
        selectBorder: selectStyle?.borderTopWidth,
        selectBackground: selectStyle?.backgroundColor,
        // Same line: the glyph's vertical centre is the select's, both inside the
        // bordered box, glyph to its left (never wrapped, never outside the box).
        sameLine: iconBox !== undefined && boxBox !== undefined && Math.abs((iconBox.top + iconBox.bottom) / 2 - (boxBox.top + boxBox.bottom) / 2) < 2,
        iconInsideBox:
          iconBox !== undefined && borderBoxBox !== undefined &&
          iconBox.top >= borderBoxBox.top - 1 && iconBox.bottom <= borderBoxBox.bottom + 1 &&
          iconBox.left >= borderBoxBox.left - 1 && iconBox.right <= borderBoxBox.right + 1,
        iconLeftOfSelect: iconBox !== undefined && boxBox !== undefined && iconBox.right <= boxBox.left + 1,
      }
    })
    expect(layout.position).toBe('sticky')
    expect(layout.shadow).not.toBe('none')
    expect(layout.background).not.toBe('rgba(0, 0, 0, 0)')
    // One box, drawn by the label; the select is transparent and borderless
    // inside it. (A border on the select itself would mean the glyph sits
    // beside the box instead of in it — the thing this test guards.)
    expect(layout.boxBorder).not.toBe('0px')
    expect(layout.boxBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(layout.selectBorder).toBe('0px')
    expect(layout.selectBackground).toBe('rgba(0, 0, 0, 0)')
    expect(layout.sameLine).toBe(true)
    expect(layout.iconInsideBox).toBe(true)
    expect(layout.iconLeftOfSelect).toBe(true)
    await picker.selectOption('apps/web')
    await expect(shown).toHaveAttribute('data-repo', 'apps/web')
    await expect(page.getByTestId('git-history-commit')).toHaveCount(1)
  } finally {
    await server.stop()
    root.dispose()
  }
})
/**
 * A repository that has been `git init`ed but never committed to (an "unborn"
 * branch) used to break both git views with
 * `EIO: git failed: fatal: your current branch 'master' does not have any
 * commits yet`: `git log` and `git diff HEAD` fail on that state, and the
 * service passed the failure on. It is a state, not an error — there are no
 * commits, and every file is new.
 */
test('git: a repository with no commits lists no history and all-new changes', async ({ page }) => {
  // An empty directory: the only files are the ones this test writes, so the
  // counts below are about the state, not about the fixture.
  const root = fixture({}, {})
  rmSync(join(root.root, 'README.md'), { recursive: true, force: true })
  for (const path of ['docs', 'src', 'LICENSE', 'blob.bin']) rmSync(join(root.root, path), { recursive: true, force: true })
  git(root.root, 'init', '-q') // no branch name: the default one, never committed
  writeFileSync(join(root.root, 'a.txt'), 'one\n')
  writeFileSync(join(root.root, 'b.txt'), 'two\n')
  const server = await startDiorama(root.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    // Changes: the files are there, and nothing is reported as a failure.
    await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
    await expect(page.getByTestId('git-changes')).not.toContainText('EIO')
    await expect(page.locator('.diorama-changes__row')).toHaveCount(2)
    // History: an empty answer with a reason, not an error box.
    await page.getByTestId('sidebar-switcher').locator('[data-view="history"]').click()
    await expect(page.getByTestId('git-history')).not.toContainText('EIO')
    await expect(page.getByTestId('git-history')).toContainText('还没有提交')
    await expect(page.getByTestId('git-history-commit')).toHaveCount(0)
    // The diff of a file in that state is its whole content (an addition), not
    // "bad revision 'HEAD'".
    await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
    await page.locator('.diorama-changes__row').filter({ hasText: 'b.txt' }).click()
    await expect(page.getByTestId('git-diff-text')).toContainText('two')
    await expect(page.getByTestId('git-diff')).not.toContainText('bad revision')
  } finally {
    await server.stop()
    root.dispose()
  }
})

/**
 * The same state one level down (the case the user hit): the mount is not a
 * repository, one of the repositories *inside* it has never been committed to.
 * The history view used to turn into a single error box for the whole mount
 * because one repository's `log` failed; now that repository is simply empty.
 */
test('git: a repository inside the mount with no commits is empty, not an error', async ({ page }) => {
  const root = fixture()
  repoAt(join(root.root, 'apps', 'web')) // committed, so there is a history next door
  mkdirSync(join(root.root, 'apps', 'api'), { recursive: true })
  writeFileSync(join(root.root, 'apps', 'api', 'a.txt'), 'one\n')
  git(join(root.root, 'apps', 'api'), 'init', '-q') // never committed
  const server = await startDiorama(root.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('sidebar-switcher').locator('[data-view="history"]').click()
    const shown = page.getByTestId('git-history-repo')
    // apps/api comes first (shallowest, then by path): it has nothing to list.
    await expect(shown).toHaveAttribute('data-repo', 'apps/api')
    await expect(page.getByTestId('git-history')).not.toContainText('EIO')
    await expect(page.getByTestId('git-history-empty')).toBeVisible()
    // The other repository still has its commit, and the picker gets there.
    await page.getByTestId('git-history-picker').selectOption('apps/web')
    await expect(page.getByTestId('git-history-commit')).toHaveCount(1)
    await expect(page.getByTestId('git-history-empty')).toHaveCount(0)
  } finally {
    await server.stop()
    root.dispose()
  }
})

test('git: a commit picked in a subdirectory repository opens in that repository', async ({ page }) => {
  const root = fixture()
  // Two repositories, so "the mount's own repository" is not either of them:
  // the mount root is not a repository at all.
  repoAt(join(root.root, 'apps', 'api'), 'a.txt')
  repoAt(join(root.root, 'apps', 'web'), 'b.txt')
  const server = await startDiorama(root.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('sidebar-switcher').locator('[data-view="history"]').click()
    // Pick the commit of the *second* repository: it lives in apps/web, not in
    // the mount's own repository (there is none), which is what used to fail
    // with "ENOENT: no such commit" — the seat asked the wrong repository.
    await page.getByTestId('git-history-picker').selectOption('apps/web')
    await expect(page.getByTestId('git-history-repo')).toHaveAttribute('data-repo', 'apps/web')
    const webRow = page.getByTestId('git-history-commit').first()
    await webRow.click()
    await expect(page.getByTestId('git-commit')).toBeVisible()
    await expect(page.getByTestId('git-commit-error')).toHaveCount(0)
    // The commit's own files are listed (and readable) in that repository.
    await expect(page.getByTestId('git-commit-file').first()).toContainText('b.txt')
    // The hash names the repository too, so a refresh comes back to the same
    // commit rather than to a sha that means nothing in the mount's root.
    expect(decodeURIComponent(new URL(page.url()).hash)).toContain('apps/web:')
    await page.reload()
    await expect(page.getByTestId('git-commit')).toBeVisible()
    await expect(page.getByTestId('git-commit-error')).toHaveCount(0)
  } finally {
    await server.stop()
    root.dispose()
  }
})