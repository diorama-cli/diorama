import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, type Diorama, type Fixture } from './support.ts'

/**
 * Picking several commits in the history view (contract.md §3.2 / §3.8 / §5 /
 * §5.2, v0.25): the right column then shows the **net change** between the
 * oldest and the newest of them, not one commit's change.
 *
 * The selection is the one every list has — plain click picks one row, Shift
 * takes the stretch from the last click, ⌘ / Ctrl adds or removes one row — and
 * the pick lives in `#history`, oldest first (`<repo>:<a>,<b>`), so a refresh
 * comes back to the same comparison.
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

/**
 * A repository with three commits, each touching a different file, so a pick of
 * two or three of them has a file list that can be checked by name.
 */
function repository(): { first: string; second: string; third: string } {
  directory = fixture()
  git(directory.root, 'init', '-q', '-b', 'main')
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', 'first commit')
  const first = git(directory.root, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(directory.root, 'src', 'app.js'), 'function hi() {\n  return "TWO"\n}\n')
  git(directory.root, 'commit', '-q', '-am', 'second commit')
  const second = git(directory.root, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(directory.root, 'docs', 'notes.md'), '# Notes\n\nthird body\n')
  git(directory.root, 'commit', '-q', '-am', 'third commit')
  const third = git(directory.root, 'rev-parse', 'HEAD').trim()
  return { first, second, third }
}

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

async function openHistory(page: Page): Promise<void> {
  await page.getByTestId('sidebar-switcher').getByRole('tab', { name: '历史' }).click()
  await expect(page.getByTestId('git-history-commit').first()).toBeVisible()
}

test('history: Shift-click picks a stretch and the seat shows its net change', async ({ page }) => {
  const shas = repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)

  const rows = page.getByTestId('git-history-commit')
  await expect(rows).toHaveCount(3)

  // Click the newest, then Shift-click the oldest: the whole stretch is picked.
  await rows.nth(0).click()
  await expect(page.getByTestId('git-commit')).not.toHaveAttribute('data-range', '')
  await rows.nth(2).click({ modifiers: ['Shift'] })

  // Shift picked the whole stretch, so all three are selected; the two ends
  // are what the diff is between, and the one in between is picked but is
  // not an end of it.
  for (const index of [0, 1, 2]) await expect(rows.nth(index)).toHaveAttribute('aria-selected', 'true')
  await expect(rows.nth(0)).toHaveClass(/diorama-changes__row--selected/)
  await expect(rows.nth(2)).toHaveClass(/diorama-changes__row--selected/)
  await expect(rows.nth(1)).toHaveClass(/diorama-history__row--picked/)
  await expect(rows.nth(1)).not.toHaveClass(/diorama-changes__row--selected/)

  // The seat draws the difference of the two ends: both changed files, not
  // one commit's file.
  const seat = page.getByTestId('git-commit')
  await expect(seat).toHaveAttribute('data-range', '')
  await expect(seat).toHaveAttribute('data-sha', shas.third)
  await expect(page.getByTestId('git-commit-message')).toContainText('…')
  // Every file the three commits touched: src/app.js was created by the first
  // one (the range starts before it), then changed by the second, and the
  // third added docs/notes.md. README.md is unchanged across the stretch.
  await expect(page.getByTestId('git-commit-file').filter({ hasText: 'src/app.js' })).toBeVisible()
  await expect(page.getByTestId('git-commit-file').filter({ hasText: 'docs/notes.md' })).toBeVisible()

  // The value is oldest first and carries every picked row — Shift picked all
  // three. (The router percent-encodes a value, so commas travel as `%2C`.)
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(
    `#history=${shas.first},${shas.second},${shas.third}`,
  )
})

test('history: the pick of several survives a refresh', async ({ page }) => {
  const shas = repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)
  const rows = page.getByTestId('git-history-commit')
  await rows.nth(0).click()
  await rows.nth(2).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('git-commit')).toHaveAttribute('data-range', '')

  await page.reload()
  await expect(page.getByTestId('sidebar-switcher').getByRole('tab', { name: '历史' })).toHaveAttribute('aria-selected', 'true')
  const seat = page.getByTestId('git-commit')
  await expect(seat).toHaveAttribute('data-range', '')
  await expect(seat).toHaveAttribute('data-sha', shas.third)
  await expect(page.getByTestId('git-commit-message')).toContainText('…')
})

test('history: a plain click goes back to one commit', async ({ page }) => {
  const shas = repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)
  const rows = page.getByTestId('git-history-commit')
  await rows.nth(0).click()
  await rows.nth(2).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('git-commit')).toHaveAttribute('data-range', '')

  // A plain click replaces the pick with that one row: the seat is a single
  // commit's change again, and the hash names one sha.
  await rows.nth(1).click()
  const seat = page.getByTestId('git-commit')
  await expect(seat).not.toHaveAttribute('data-range', '')
  await expect(seat).toHaveAttribute('data-sha', shas.second)
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(`#history=${shas.second}`)
  // The commit's own change: one file.
  await expect(page.getByTestId('git-commit-file')).toHaveCount(1)
  await expect(page.getByTestId('git-commit-file').first()).toHaveAttribute('data-file', 'src/app.js')
})

test('history: `mod`-click adds and removes single rows', async ({ page }) => {
  repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)
  const rows = page.getByTestId('git-history-commit')
  await rows.nth(0).click()
  // Adding an older one: the pick is those two, and the seat compares them.
  await rows.nth(2).click({ modifiers: [MOD] })
  await expect(page.getByTestId('git-commit')).toHaveAttribute('data-range', '')
  await expect(rows.nth(1)).not.toHaveAttribute('aria-selected', 'true')
  await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true')
  // The row between the two picks is **covered** by the diff (the change spans
  // it) without having been picked.
  await expect(rows.nth(1)).toHaveAttribute('data-covered', '')
  await expect(rows.nth(1)).not.toHaveAttribute('data-picked', '')
  // Taking the newest one out leaves the older one alone: one pick, so there
  // is no stretch any more and the row between them is plain again.
  await rows.nth(0).click({ modifiers: [MOD] })
  await expect(page.getByTestId('git-commit')).not.toHaveAttribute('data-range', '')
  await expect(rows.nth(0)).not.toHaveAttribute('aria-selected', 'true')
  await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true')
  await expect(rows.nth(1)).not.toHaveAttribute('data-covered', '')
})

/**
 * The semantics of a pick (v0.25, the bug this test locks down): **every picked
 * commit's own change is in the answer**, the oldest one included. Comparing
 * the two ends with each other would show the newer commits only — pick four,
 * see three — and picking one commit on its own would then disagree with
 * picking it as the oldest of a stretch.
 */
test('history: a pick covers every picked commit, the oldest one included', async ({ page }) => {
  const shas = repository()
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)
  const rows = page.getByTestId('git-history-commit')

  // The two oldest commits: the second changes src/app.js, the first creates
  // it — and it is the repository's first commit, so there is no parent.
  await rows.nth(2).click()
  await rows.nth(1).click({ modifiers: ['Shift'] })
  const seat = page.getByTestId('git-commit')
  await expect(seat).toHaveAttribute('data-range', '')
  await expect(seat).toContainText('这 2 个提交的改动')
  // src/app.js reads as an **addition** (the range starts before the commit
  // that created it) and carries the first commit's text as well.
  const file = page.getByTestId('git-commit-file').filter({ hasText: 'src/app.js' })
  await file.click()
  const diff = page.getByTestId('git-commit-diff-text')
  await expect(diff).toContainText('new file mode')
  await expect(diff).toContainText('function hi()')
  await expect(diff).toContainText('TWO')

  // The newest commit on its own, and the same commit as the newest of a
  // three-commit pick, agree about that commit: both show its change.
  await rows.nth(0).click()
  await expect(page.getByTestId('git-commit')).not.toHaveAttribute('data-range', '')
  await expect(page.getByTestId('git-commit-file')).toHaveCount(1)
  const alone = await page.getByTestId('git-commit-diff-text').textContent()
  await rows.nth(2).click({ modifiers: ['Shift'] })
  await page.getByTestId('git-commit-file').filter({ hasText: 'docs/notes.md' }).click()
  await expect(page.getByTestId('git-commit-diff-text')).toContainText('+third body')
  expect(alone).toContain('+third body')
  void shas
})
