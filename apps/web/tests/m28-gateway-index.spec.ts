import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { fixture, repoRoot } from './support.ts'

/**
 * The gateway's index page (contract.md §7.7): one fixed address from
 * `[gateway] port` in `$DIORAMA_HOME/diorama.toml` that lists every mount and
 * opens it in a new window. Mount URLs die with the gateway; this one does not,
 * which is the whole reason it exists.
 */

const run = promisify(execFile)
const cli = join(repoRoot, 'packages/cli/bin/diorama-beta')

async function diorama(
  home: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, DIORAMA_HOME: home },
      timeout: 30_000,
    })
    return { code: 0, stdout, stderr }
  } catch (failure) {
    const error = failure as { code?: number; stdout?: string; stderr?: string }
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** A state directory whose `diorama.toml` turns the index page on. */
function homeWithIndex(port: number): string {
  const home = mkdtempSync(join(tmpdir(), 'diorama-index-'))
  writeFileSync(join(home, 'diorama.toml'), '[gateway]\nport = ' + port + '\n')
  return home
}

/** A free TCP port, released before the gateway binds it. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('no port'))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

test('7. the index page lists every mount and opens each in a new window', async ({ browser }) => {
  const port = await freePort()
  const home = homeWithIndex(port)
  const first = fixture({ 'one.txt': 'one\n' })
  const second = fixture({ 'two.txt': 'two\n' })
  try {
    const mounted: { root: string; url: string }[] = []
    for (const directory of [first, second]) {
      const mount = await diorama(home, [directory.root])
      expect(mount.code).toBe(0)
      mounted.push({ root: directory.realRoot, url: mount.stdout.match(/http:\/\/\S+\//)?.[0] ?? '' })
    }

    // The CLI names the index page: it is the address worth keeping.
    const status = await diorama(home, ['gateway', 'status'])
    expect(status.stdout).toContain('index:  http://127.0.0.1:' + port + '/')
    const ls = await diorama(home, ['ls'])
    expect(ls.stdout).toContain('index: http://127.0.0.1:' + port + '/')
    const json = JSON.parse((await diorama(home, ['ls', '--json'])).stdout) as { gateway: { index?: string } }
    expect(json.gateway.index).toBe('http://127.0.0.1:' + port + '/')

    const page = await browser.newPage()
    try {
      await page.goto('http://127.0.0.1:' + port + '/')
      const rows = page.getByTestId('gateway-index-mount')
      await expect(rows).toHaveCount(2)
      for (const [index, entry] of mounted.entries()) {
        const row = rows.nth(index)
        await expect(row).toHaveAttribute('data-root', entry.root)
        await expect(row).toHaveAttribute('data-url', entry.url)
        // The whole row is a link that opens a window of its own.
        const link = row.locator('a')
        await expect(link).toHaveAttribute('href', entry.url)
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toContainText(entry.root)
      }

      // Clicking really opens a new tab, and that tab is the mount's own page.
      const [opened] = await Promise.all([page.context().waitForEvent('page'), rows.first().locator('a').click()])
      try {
        await opened.waitForLoadState()
        expect(opened.url()).toBe(mounted[0]!.url)
        await expect(opened.getByTestId('file-tree')).toContainText('one.txt')
      } finally {
        await opened.close()
      }

      // The page is rendered from the table on every request (no cache), so a
      // reload is enough to follow mounts going away.
      await diorama(home, ['stop', second.root])
      await page.reload()
      await expect(page.getByTestId('gateway-index-mount')).toHaveCount(1)
      await expect(page.getByTestId('gateway-index')).not.toContainText(second.realRoot)
      // With nothing mounted the page says so instead of showing an empty list.
      await diorama(home, ['stop', '--all'])
      await page.reload()
      await expect(page.getByTestId('gateway-index-empty')).toBeVisible()
    } finally {
      await page.close()
    }
  } finally {
    await diorama(home, ['gateway', 'stop', '--force'])
    rmSync(home, { recursive: true, force: true })
    first.dispose()
    second.dispose()
  }
})

test('7b. no [gateway] port means no index page, and the CLI says so', async () => {
  // No `diorama.toml` at all: the defaults, where the page is off (contract
  // §7.7 — a random port would be an address nobody can bookmark).
  const home = mkdtempSync(join(tmpdir(), 'diorama-index-'))
  try {
    expect((await diorama(home, ['gateway', 'start'])).code).toBe(0)
    // The control plane does not report an index at all, so `--json` has no key.
    const json = JSON.parse((await diorama(home, ['ls', '--json'])).stdout) as { gateway: { index?: string } }
    expect(json.gateway.index).toBeUndefined()
    // The human form says it is off, and where the switch lives.
    const running = await diorama(home, ['gateway', 'status'])
    expect(running.stdout).toContain('index:  off (set [gateway] port in ')
    expect(running.stdout).toContain(join(home, 'diorama.toml'))
  } finally {
    await diorama(home, ['gateway', 'stop', '--force'])
    rmSync(home, { recursive: true, force: true })
  }
})

test('7c. an index port that is taken fails loud, naming the port', async () => {
  const port = await freePort()
  const first = homeWithIndex(port)
  const second = homeWithIndex(port)
  try {
    expect((await diorama(first, ['gateway', 'start'])).code).toBe(0)
    const clash = await diorama(second, ['gateway', 'start'])
    // The daemon cannot answer, and the CLI quotes the reason from its log:
    // "port 7777 is already in use" beats "did not answer in time".
    expect(clash.code).toBe(1)
    expect(clash.stderr).toContain('index page port ' + port + ' is already in use')
    // Nothing is left behind for a gateway that never finished starting.
    expect((await diorama(second, ['gateway', 'status'])).code).toBe(1)
  } finally {
    await diorama(first, ['gateway', 'stop', '--force'])
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})
