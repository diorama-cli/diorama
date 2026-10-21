import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { fixture, repoRoot } from './support.ts'

/**
 * `diorama <dir> --json` (contract.md §7.6): the mount as **one** JSON document
 * so another program can read the URL without parsing prose. Each test owns its
 * `DIORAMA_HOME`, hence its own gateway.
 */

const run = promisify(execFile)
const cli = join(repoRoot, 'packages/cli/bin/diorama-beta')

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
  const home = mkdtempSync(join(tmpdir(), 'diorama-json-'))
  try {
    await fn(home)
  } finally {
    await diorama(home, ['gateway', 'stop', '--force'])
    rmSync(home, { recursive: true, force: true })
  }
}

/** The shape another program reads (contract.md §7.6). */
interface MountJson {
  mount: {
    mountId: string
    root: string
    port: number
    url: string
    state: string
    configFile?: string
    plugins: string[]
    hidden: string[]
  }
  url: string
  root: string
  mountId: string
  created: boolean
  pluginFailures?: string
}

/** stdout must be exactly one JSON document: nothing before it, nothing after. */
function parseMount(stdout: string): MountJson {
  const lines = stdout.trimEnd().split('\n')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0] as string) as MountJson
}

test('j1. `--json` prints one document whose url serves the directory', async () => {
  await withHome(async home => {
    const directory = fixture({ 'json.txt': 'json\n' })
    try {
      const mount = await diorama(home, [directory.root, '--json'])
      expect(mount.code).toBe(0)
      // stdout is the document; the human lines are not printed alongside it.
      expect(mount.stdout).not.toContain('diorama serving')
      const document = parseMount(mount.stdout)

      expect(document.url).toBe(document.mount.url)
      expect(document.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(document.root).toBe(directory.realRoot)
      expect(document.mount.root).toBe(directory.realRoot)
      expect(document.mountId).toBe(document.mount.mountId)
      expect(document.created).toBe(true)
      expect(document.mount.state).toBe('ok')
      expect(document.mount.hidden).toEqual(['.git', 'node_modules'])
      expect(document.mount.plugins.length).toBeGreaterThan(0)
      // The URL in the document is the live page (no prose to parse).
      const response = await fetch(`${document.url}plugin.json`)
      expect(response.ok).toBe(true)
      const manifest = (await response.json()) as { mountId: string }
      expect(manifest.mountId).toBe(document.mountId)

      // `ls --json` agrees with the document.
      const ls = await diorama(home, ['ls', '--json'])
      const listed = JSON.parse(ls.stdout) as { mounts: { url: string }[] }
      expect(listed.mounts.map(entry => entry.url)).toEqual([document.url])
    } finally {
      directory.dispose()
    }
  })
})

test('j2. mounting an existing directory reports the same URL with created: false', async () => {
  await withHome(async home => {
    const directory = fixture()
    try {
      const first = parseMount((await diorama(home, [directory.root, '--json'])).stdout)
      const again = await diorama(home, [directory.root, '--json'])
      expect(again.code).toBe(0)
      const second = parseMount(again.stdout)
      expect(second.created).toBe(false)
      expect(second.url).toBe(first.url)
      expect(second.mountId).toBe(first.mountId)
    } finally {
      directory.dispose()
    }
  })
})

test('j3. `restart <dir> --json` reports the new mount and what it replaced', async () => {
  await withHome(async home => {
    const directory = fixture()
    try {
      const before = parseMount((await diorama(home, [directory.root, '--json'])).stdout)
      const restart = await diorama(home, ['restart', directory.root, '--json'])
      expect(restart.code).toBe(0)
      const document = parseMount(restart.stdout) as MountJson & { remounted: string | null }
      expect(document.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(document.url).not.toBe(before.url)
      expect(document.remounted).toBe(before.mountId)
    } finally {
      directory.dispose()
    }
  })
})

test('j4. without `--json` the five lines are unchanged', async () => {
  await withHome(async home => {
    const directory = fixture()
    try {
      const plain = await diorama(home, [directory.root])
      expect(plain.code).toBe(0)
      const lines = plain.stdout.trimEnd().split('\n')
      expect(lines[0]).toBe(`diorama-beta serving ${directory.realRoot}`)
      expect(lines[1]).toMatch(/^ {2}http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(lines[2]).toBe('  config: none (defaults)')
      expect(lines[3]).toMatch(/^ {2}\[mount:[0-9a-f]+\] plugins: /)
      expect(lines[4]).toBe('  hidden: .git, node_modules')
      // The short-lived CLI is the beta channel; the human lines name it.
      expect(plain.stdout).toContain('diorama-beta serving')
    } finally {
      directory.dispose()
    }
  })
})

test('j5. `--json --foreground` prints the document and keeps serving; a bad directory is exit 2', async () => {
  await withHome(async home => {
    const directory = fixture()
    let child: ReturnType<typeof spawn> | undefined
    try {
      // The foreground form does not exit, so the document arrives on stdout
      // while the process keeps running — a wrapper reads one line and owns the
      // child. (It also runs the gateway in this process, so no daemon.)
      child = spawn(process.execPath, [cli, directory.root, '--json', '--foreground'], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DIORAMA_HOME: home },
      })
      let stdout = ''
      const document = await new Promise<MountJson>((ready, fail) => {
        const timer = setTimeout(() => fail(new Error(`no document:\n${stdout}`)), 30_000)
        child?.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
          const newline = stdout.indexOf('\n')
          if (newline === -1) return
          clearTimeout(timer)
          ready(JSON.parse(stdout.slice(0, newline)) as MountJson)
        })
        child?.on('exit', code => {
          clearTimeout(timer)
          fail(new Error(`exited (${code ?? '?'}):\n${stdout}`))
        })
      })
      expect(document.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(document.mount.root).toBe(directory.realRoot)
      // The process is still alive: that is what `--foreground` means.
      expect(child.exitCode).toBeNull()
      expect((await fetch(`${document.url}plugin.json`)).ok).toBe(true)
      child.kill('SIGTERM')
      await new Promise<void>(done => child?.once('exit', () => done()))

      const missing = await diorama(home, [join(directory.root, 'nope'), '--json'])
      expect(missing.code).toBe(2)
      expect(missing.stderr).toContain('not a readable directory')
      // Nothing on stdout: a caller must not parse an error as a mount.
      expect(missing.stdout).toBe('')
    } finally {
      child?.kill('SIGKILL')
      directory.dispose()
    }
  })
})
