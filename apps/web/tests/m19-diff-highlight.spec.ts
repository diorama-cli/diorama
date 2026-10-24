import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama } from './support.ts'

/**
 * Syntax highlighting in the diff readers (contract.md §5.2, docs/m19/spec.md).
 *
 * The two readers that show **file content** — "whole file" (one column) and
 * "side by side" (two) — colour their rows with the same engine the `code`
 * renderer uses. The unified diff does not: its lines are git's own text (a
 * `+` prefix, a hunk header), not source code.
 */

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  )
}

const SOURCE = [
  'function greet(name) {',
  '  // a comment',
  '  const message = "hello"',
  '  return message + name',
  '}',
  '',
].join('\n')

/** Open one file's diff in the changes view, and return its reader. */
async function openDiff(page: Page, url: string, path: string) {
  await page.goto(url)
  await page.getByTestId('sidebar-switcher').locator('[data-view="changes"]').click()
  await page.getByTestId('git-changes').locator(`[data-path="${path}"]`).click()
  const diff = page.getByTestId('tabs-content').filter({ visible: true }).getByTestId('git-diff')
  await expect(diff).toBeVisible()
  return diff
}

test('diff: the whole-file reader highlights the code around the change', async ({ page }) => {
  const repo = fixture()
  writeFileSync(join(repo.root, 'src/greet.js'), SOURCE)
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'src/greet.js'), SOURCE.replace('"hello"', '"hi there"'))
  const server = await startDiorama(repo.root)
  try {
    const diff = await openDiff(page, server.url, 'src/greet.js')
    // The unified diff stays plain: it is git's text, not source.
    await expect(diff).toHaveAttribute('data-mode', 'inline')
    const inline = diff.getByTestId('git-diff-text')
    await expect(inline.locator('.hljs-keyword')).toHaveCount(0)
    await expect(inline).toContainText('function greet')

    await diff.getByTestId('git-diff-mode-file').click()
    const whole = diff.getByTestId('git-diff-text')
    await expect(whole).toHaveAttribute('data-mode', 'file')
    // The language is known from the path, and the tokens are drawn.
    await expect(whole).toHaveAttribute('data-language', 'javascript')
    await expect(whole.locator('.hljs-keyword').first()).toBeVisible()
    // A comment keeps its own colour, and a string its own — on the rows the
    // reader draws, including the changed one.
    await expect(whole.locator('.hljs-comment')).toContainText('// a comment')
    await expect(whole.locator('.hljs-string').first()).toContainText('hello')
    // The change is still readable as a change: tone wins on the row.
    const added = whole.locator('[data-tone="add"]')
    await expect(added).toHaveCount(1)
    await expect(added.locator('.hljs-string')).toContainText('hi there')
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('diff: both columns of the side-by-side reader are highlighted', async ({ page }) => {
  const repo = fixture()
  writeFileSync(join(repo.root, 'src/greet.js'), SOURCE)
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'src/greet.js'), SOURCE.replace('"hello"', '"hi there"'))
  const server = await startDiorama(repo.root)
  try {
    const diff = await openDiff(page, server.url, 'src/greet.js')
    await diff.getByTestId('git-diff-mode-split').click()
    const split = diff.getByTestId('git-diff-text')
    await expect(split).toHaveAttribute('data-mode', 'split')
    await expect(split).toHaveAttribute('data-language', 'javascript')
    // The old side keeps the old string, the new side the new one: each cell
    // carries its own fragment (a span may not run across two rows).
    const changed = split.locator('.diorama-diff__split-row').filter({ hasText: 'hi there' })
    await expect(changed).toHaveCount(1)
    await expect(changed.locator('[data-tone="del"] .hljs-string')).toHaveText('"hello"')
    await expect(changed.locator('[data-tone="add"] .hljs-string')).toHaveText('"hi there"')
    // Unchanged rows are coloured on both sides (one read of the file).
    const keywordRows = split.locator('.diorama-diff__split-row').filter({ hasText: 'function greet' })
    await expect(keywordRows).toHaveCount(1)
    await expect(keywordRows.locator('[data-tone="context"] .hljs-keyword').first()).toHaveText('function')
  } finally {
    await server.stop()
    repo.dispose()
  }
})

test('diff: a file the engine does not know is drawn plain, not broken', async ({ page }) => {
  const repo = fixture()
  writeFileSync(join(repo.root, 'notes.txt'), 'one\ntwo\n')
  git(repo.root, 'init', '-q', '-b', 'main')
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'first')
  writeFileSync(join(repo.root, 'notes.txt'), 'one\nTWO\n')
  const server = await startDiorama(repo.root)
  try {
    const diff = await openDiff(page, server.url, 'notes.txt')
    await diff.getByTestId('git-diff-mode-file').click()
    const whole = diff.getByTestId('git-diff-text')
    await expect(whole).toHaveAttribute('data-language', 'plaintext')
    await expect(whole.locator('.hljs-keyword')).toHaveCount(0)
    // The text is still there, escaped rather than interpreted.
    await expect(whole).toContainText('TWO')
    await expect(whole.locator('[data-tone="add"]')).toHaveCount(1)
  } finally {
    await server.stop()
    repo.dispose()
  }
})
