import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fixture, startDiorama, type Diorama, type Fixture } from './support.ts'

/**
 * The commit graph of the history view (contract.md §5.2): every row
 * carries a lane, a dot, and lines that meet the rows above and below.
 *
 * The layout itself is unit-tested (`git-changes/test/graph.test.ts`); what is
 * tested here is that the page draws it — one dot per commit, in the commit's
 * own lane, with the lines actually stroked in the lane colours (not, say,
 * `stroke: currentColor` on a transparent column, which would pass every
 * text assertion and show nothing).
 */

let directory: Fixture
let server: Diorama

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Sue', '-c', 'user.email=sue@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  )
}

/** A file per commit, so each commit has something to say. */
function write(root: string, name: string, text: string): void {
  writeFileSync(join(root, name), text)
}

test.afterEach(async () => {
  await server?.stop()
  directory?.dispose()
})

async function openHistory(page: Page): Promise<void> {
  await page.getByTestId('sidebar-switcher').getByRole('tab', { name: '历史' }).click()
  await expect(page.getByTestId('git-history-commit').first()).toBeVisible()
}

test('graph: a straight history is one lane of dots', async ({ page }) => {
  directory = fixture()
  git(directory.root, 'init', '-q', '-b', 'main')
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', 'first')
  write(directory.root, 'one.txt', 'one\n')
  git(directory.root, 'add', '-A')
  git(directory.root, 'commit', '-q', '-m', 'second')
  server = await startDiorama(directory.root)
  await page.goto(server.url)
  await openHistory(page)

  const rows = page.getByTestId('git-history-commit')
  await expect(rows).toHaveCount(2)
  const dots = page.getByTestId('git-history-dot')
  await expect(dots).toHaveCount(2)
  // Both commits are on the same line: lane 0, one lane wide.
  await expect(dots.first()).toHaveAttribute('data-lane', '0')
  await expect(dots.nth(1)).toHaveAttribute('data-lane', '0')
  const graph = page.getByTestId('git-history-graph').first()
  await expect(graph).toHaveAttribute('data-lanes', '1')
  // The column is drawn, not just reserved: one lane's worth of pixels.
  const box = await graph.boundingBox()
  expect(box?.width ?? 0).toBeGreaterThan(6)
})

test('graph: a branch gets a second lane and a line back to its parent', async ({ page }) => {
  directory = fixture()
  const root = directory.root
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'first')
  git(root, 'checkout', '-q', '-b', 'feature')
  write(root, 'feature.txt', 'feature\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'on the branch')
  git(root, 'checkout', '-q', 'main')
  write(root, 'main.txt', 'main\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'on main')
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature')
  server = await startDiorama(root)
  await page.goto(server.url)
  await openHistory(page)

  // Four commits: the merge, then the branch and main side by side, then the
  // first commit they share.
  const rows = page.getByTestId('git-history-commit')
  await expect(rows).toHaveCount(4)
  const dots = page.getByTestId('git-history-dot')
  await expect(dots).toHaveCount(4)
  // The merge sits on the main line; the branch and main are two lanes.
  const lanes = await dots.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-lane')))
  expect(lanes[0]).toBe('0')
  expect(new Set(lanes).size).toBe(2)
  // The column is two lanes wide, and the lines carry a colour token each: a
  // transparent or unset stroke would draw nothing and still pass a text check.
  await expect(page.getByTestId('git-history-graph').first()).toHaveAttribute('data-lanes', '2')
  const strokes = await page
    .getByTestId('git-history-line')
    .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).stroke))
  expect(strokes.length).toBeGreaterThan(0)
  for (const stroke of strokes) expect(stroke).not.toBe('none')
  // Two colours are in play: the branch is not the same line as main.
  expect(new Set(strokes).size).toBeGreaterThan(1)
})

test('graph: rows meet — a line leaves a row at the lane the next one arrives in', async ({ page }) => {
  directory = fixture()
  const root = directory.root
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'first')
  git(root, 'checkout', '-q', '-b', 'side')
  write(root, 'side.txt', 'side\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'side commit')
  git(root, 'checkout', '-q', 'main')
  write(root, 'main.txt', 'main\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'main commit')
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
  server = await startDiorama(root)
  await page.goto(server.url)
  await openHistory(page)

  const rows = page.getByTestId('git-history-commit')
  const count = await rows.count()
  expect(count).toBe(4)
  // The graph column of each row is as tall as the row: the lines meet the
  // neighbouring rows' lines at the row's edges instead of floating.
  for (let index = 0; index < count; index++) {
    const row = await rows.nth(index).boundingBox()
    const graph = await page.getByTestId('git-history-graph').nth(index).boundingBox()
    expect(Math.abs((row?.height ?? 0) - (graph?.height ?? 0))).toBeLessThan(1)
  }
})
