import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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

test('git: the history view groups commits by repository', async ({ page }) => {
  const root = fixture()
  repoAt(join(root.root, 'apps', 'api'))
  repoAt(join(root.root, 'apps', 'web'))
  const server = await startDiorama(root.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('sidebar-switcher').locator('[data-view="history"]').click()
    await expect(page.getByTestId('git-history-commit')).toHaveCount(2)
    await expect(page.getByTestId('git-changes-repo')).toHaveCount(2)
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
    // Pick the commit of the *second* group: it lives in apps/web, not in the
    // mount's own repository (there is none), which is what used to fail with
    // "ENOENT: no such commit" — the seat asked the wrong repository.
    const webRow = page.getByTestId('git-history-repo').filter({ hasText: 'apps/web' }).getByTestId('git-history-commit').first()
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