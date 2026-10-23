import { appendFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { fixture, startDiorama, waitForPage } from './support.ts'

/**
 * M2 S6 (docs/m2/spec.md §4 rows 10–11, contract.md §3.1/§4): `fs.watch` over
 * an RPC subscription drives the page. Changes are made on disk while the page
 * sits idle — nothing is clicked or reloaded between the change and the
 * assertion.
 */

test('10. editing an open file refreshes its content', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('file-tree').locator('[data-path="LICENSE"]').click()
    await expect(page.getByTestId('plaintext')).toContainText('plain text license', { timeout: 10_000 })

    appendFileSync(join(directory.root, 'LICENSE'), 'second line\n')
    await expect(page.getByTestId('plaintext')).toContainText('second line', { timeout: 10_000 })

    writeFileSync(join(directory.root, 'LICENSE'), 'rewritten\n')
    await expect(page.getByTestId('plaintext')).toContainText('rewritten', { timeout: 10_000 })
    await expect(page.getByTestId('plaintext')).not.toContainText('second line')
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('11. a created file appears in the tree; a deleted one is reported', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    await expect(tree.locator('[data-path="README.md"]')).toBeVisible()

    writeFileSync(join(directory.root, 'added-while-open.txt'), 'new\n')
    await expect(tree.locator('[data-path="added-while-open.txt"]')).toBeVisible({ timeout: 10_000 })

    unlinkSync(join(directory.root, 'added-while-open.txt'))
    await expect(tree.locator('[data-path="added-while-open.txt"]')).toHaveCount(0, { timeout: 10_000 })

    // Deleting an open file: the tab says the file is gone (ENOENT), not stale text.
    await tree.locator('[data-path="LICENSE"]').click()
    await expect(page.getByTestId('plaintext')).toContainText('plain text license', { timeout: 10_000 })
    rmSync(join(directory.root, 'LICENSE'))
    await expect(page.getByTestId('renderer-read-error')).toContainText('ENOENT', { timeout: 10_000 })
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('12. a dropped network reconnects by itself, and the page catches up', async ({ page, context }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    const tree = page.getByTestId('file-tree')
    await tree.locator('[data-path="LICENSE"]').click()
    await expect(page.getByTestId('plaintext')).toContainText('plain text license', { timeout: 10_000 })

    // The network goes away, a file changes while nobody is listening, and the
    // network comes back. Nothing is clicked and the page is not reloaded: the
    // RPC channel dials again, restarts its watches and the readers re-read.
    await context.setOffline(true)
    await page.waitForTimeout(1_000)
    writeFileSync(join(directory.root, 'LICENSE'), 'written while offline\n')
    writeFileSync(join(directory.root, 'added-while-offline.txt'), 'new\n')
    await context.setOffline(false)

    await expect(page.getByTestId('plaintext')).toContainText('written while offline', { timeout: 30_000 })
    await expect(tree.locator('[data-path="added-while-offline.txt"]')).toBeVisible({ timeout: 30_000 })

    // And the connection is live again: a change made now arrives the usual way.
    writeFileSync(join(directory.root, 'LICENSE'), 'after the reconnect\n')
    await expect(page.getByTestId('plaintext')).toContainText('after the reconnect', { timeout: 15_000 })
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('10b. auto-refresh off stops content updates; the toggle is a command', async ({ page }) => {
  const directory = fixture()
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    await waitForPage(page)
    await page.getByTestId('file-tree').locator('[data-path="LICENSE"]').click()
    const pane = page.getByTestId('plaintext')
    await expect(pane).toContainText('plain text license', { timeout: 10_000 })

    // Turn automatic refresh off through the registry (a palette row in real use).
    await page.evaluate(() => {
      const kernel = (window as unknown as { __diorama_page__: { getKernel(): { ctx: { commands: { run(id: string): Promise<boolean> } } } } }).__diorama_page__.getKernel()
      void kernel.ctx.commands.run('view.toggleAutoRefresh')
    })
    writeFileSync(join(directory.root, 'LICENSE'), 'while off\n')
    await page.waitForTimeout(1500)
    await expect(pane).not.toContainText('while off')

    // Back on: the change is picked up (the toggle re-reads on turning on).
    await page.evaluate(() => {
      const kernel = (window as unknown as { __diorama_page__: { getKernel(): { ctx: { commands: { run(id: string): Promise<boolean> } } } } }).__diorama_page__.getKernel()
      void kernel.ctx.commands.run('view.toggleAutoRefresh')
    })
    await expect(pane).toContainText('while off', { timeout: 10_000 })
  } finally {
    await server.stop()
    directory.dispose()
  }
})
