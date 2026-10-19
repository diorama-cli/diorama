import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { fixture, repoRoot } from './support.ts'

/**
 * M3 S4 (contract.md §7.4–§7.6): the short-lived CLI verbs, their exit codes
 * and the `ls` table. Each test drives the real binary with its own
 * `DIORAMA_HOME`, so no test sees another's gateway.
 */

const run = promisify(execFile)
const cli = join(repoRoot, 'packages/cli/bin/diorama-beta')

/** Run one CLI command against a temp state directory. */
async function diorama(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, DIORAMA_HOME: home },
      timeout: 30_000,
    })
    return { code: 0, stdout, stderr }
  } catch (failure) {
    const error = failure as { code?: number; stdout?: string; stderr?: string }
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'diorama-cli-'))
  try {
    await fn(home)
  } finally {
    await diorama(home, ['gateway', 'stop', '--force'])
    rmSync(home, { recursive: true, force: true })
  }
}

test('5. exit codes when no gateway runs: ls 0, status 1, stop 0', async () => {
  await withHome(async home => {
    const ls = await diorama(home, ['ls'])
    expect(ls.code).toBe(0)
    expect(ls.stdout).toContain('gateway is not running')

    const status = await diorama(home, ['gateway', 'status'])
    expect(status.code).toBe(1)

    const stop = await diorama(home, ['gateway', 'stop'])
    expect(stop.code).toBe(0)
    expect(stop.stdout).toContain('gateway is not running')
  })
})

test('5b. start, mount, ls (with URLs), restart, stop', async () => {
  await withHome(async home => {
    const directory = fixture({ 'cli.txt': 'cli\n' })
    try {
      const start = await diorama(home, ['gateway', 'start'])
      expect(start.code).toBe(0)
      expect(start.stdout).toContain('gateway started')

      // Starting again is not an error: it reports the running gateway.
      const again = await diorama(home, ['gateway', 'start'])
      expect(again.code).toBe(0)
      expect(again.stdout).toContain('already running')

      const mount = await diorama(home, [directory.root])
      expect(mount.code).toBe(0)
      const url = mount.stdout.match(/http:\/\/\S+\//)?.[0] ?? ''
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(mount.stdout).toContain('config: none (defaults)')
      expect(mount.stdout).toContain('hidden: .git, node_modules')

      const ls = await diorama(home, ['ls'])
      expect(ls.code).toBe(0)
      // contract.md §7.6: the table carries the directory and its URL.
      expect(ls.stdout).toMatch(/MOUNT\s+PORT\s+STATUS\s+DIR\s+URL\s+CONFIG/)
      expect(ls.stdout).toContain(directory.realRoot)
      expect(ls.stdout).toContain(url)
      expect(ls.stdout).toContain('ok')
      expect(ls.stdout).toContain('(defaults)')

      const json = await diorama(home, ['ls', '--json'])
      expect(json.code).toBe(0)
      const parsed = JSON.parse(json.stdout) as { running: boolean; mounts: { root: string; url: string }[] }
      expect(parsed.running).toBe(true)
      expect(parsed.mounts.map(mount => mount.url)).toEqual([url])

      const status = await diorama(home, ['gateway', 'status'])
      expect(status.code).toBe(0)
      expect(status.stdout).toContain('gateway running')
      expect(status.stdout).toContain(url)

      // `restart <dir>` unmounts and mounts again: a new mount, a new URL.
      const restart = await diorama(home, ['restart', directory.root])
      expect(restart.code).toBe(0)
      const newUrl = restart.stdout.match(/http:\/\/\S+\//)?.[0] ?? ''
      expect(newUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(newUrl).not.toBe(url)

      const stop = await diorama(home, ['gateway', 'stop'])
      expect(stop.code).toBe(0)
      expect(stop.stdout).toContain('gateway stopped')
      const after = await diorama(home, ['ls'])
      expect(after.stdout).toContain('gateway is not running')
    } finally {
      directory.dispose()
    }
  })
})

test('5c. a missing directory exits 2; an explicit busy port exits 1', async () => {
  await withHome(async home => {
    const directory = fixture()
    try {
      const missing = await diorama(home, [join(directory.root, 'nope')])
      expect(missing.code).toBe(2)
      expect(missing.stderr).toContain('not a readable directory')

      const first = await diorama(home, [directory.root])
      expect(first.code).toBe(0)
      const port = Number(new URL(first.stdout.match(/http:\/\/\S+\//)?.[0] ?? 'http://x:0/').port)
      const other = fixture()
      try {
        const busy = await diorama(home, [other.root, '--port', String(port)])
        expect(busy.code).toBe(1)
        expect(busy.stderr).toContain('already in use')
      } finally {
        other.dispose()
      }
    } finally {
      directory.dispose()
    }
  })
})

test('5d. a broken diorama.toml exits 2 and names the file (CLI-side merge)', async () => {
  await withHome(async home => {
    const directory = fixture({ 'diorama.toml': 'port = "not a number"\n' })
    try {
      const result = await diorama(home, [directory.root])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('diorama.toml')
      expect(result.stderr).toContain('"port"')
    } finally {
      directory.dispose()
    }
  })
})

test('5e. a global ~/.diorama/diorama.toml applies when the directory has none', async () => {
  await withHome(async home => {
    writeFileSync(join(home, 'diorama.toml'), '[watch]\nmaxDirectories = 7\n')
    const directory = fixture()
    try {
      const mount = await diorama(home, [directory.root])
      expect(mount.code).toBe(0)
      expect(mount.stdout).toContain(`config: ${join(home, 'diorama.toml')}`)
      // The table shows where the configuration came from.
      const ls = await diorama(home, ['ls'])
      expect(ls.stdout).toContain('diorama.toml')
    } finally {
      directory.dispose()
    }
  })
})

test('5f. gateway restart drops the mounts (no persistence, contract.md §7.4)', async () => {
  await withHome(async home => {
    const directory = fixture()
    try {
      expect((await diorama(home, [directory.root])).code).toBe(0)
      const restart = await diorama(home, ['gateway', 'restart'])
      expect(restart.code).toBe(0)
      const ls = await diorama(home, ['ls'])
      expect(ls.stdout).toContain('no mounts')
    } finally {
      directory.dispose()
    }
  })
})
