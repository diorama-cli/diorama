import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { fixture, repoRoot, startDiorama } from './support.ts'

/**
 * M10 (contract.md §4.2): `diorama config` reads, edits and interactively
 * builds a `diorama.toml`, and what it writes is what serving picks up next.
 *
 * Every test drives the real binary against its own `DIORAMA_HOME`, so the
 * global config file of one test never leaks into another.
 */
const run = promisify(execFile)
const cli = join(repoRoot, 'packages/cli/bin/diorama-beta')

async function diorama(
  home: string,
  args: string[],
  options: { input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (options.input === undefined) {
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
  // The wizard reads stdin: `execFile` has no `input` option, so drive a spawn
  // and close the pipe — an open stdin would leave the wizard waiting forever.
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { ...process.env, DIORAMA_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => (stdout += chunk))
  child.stderr.on('data', (chunk: string) => (stderr += chunk))
  child.stdin.end(options.input)
  const code = await new Promise<number | null>(done => child.on('exit', done))
  return { code: code ?? 1, stdout, stderr }
}

/** A throwaway state directory; the caller removes it. */
function stateHome(): string {
  return mkdtempSync(join(tmpdir(), 'diorama-config-home-'))
}

test('1. config set writes the project file, and the next mount uses it', async () => {
  const home = stateHome()
  const directory = fixture()
  try {
    const set = await diorama(home, ['config', 'set', '--dir', directory.root, '--ignore', 'docs', '--watch.enabled', 'false'])
    expect(set.code).toBe(0)
    expect(set.stdout).toContain('wrote ')
    const written = readFileSync(join(directory.root, 'diorama.toml'), 'utf8')
    expect(written).toContain('ignore = [ "docs" ]')
    expect(written).toContain('[watch]')
    expect(written).toContain('enabled = false')

    // `--dump-config` is the same merge serving uses: the file is in effect.
    const dump = await diorama(home, [directory.root, '--dump-config'])
    const config = JSON.parse(dump.stdout) as {
      config: { ignore: string[]; watch: { enabled: boolean } }
      configFile: string
    }
    expect(config.config.ignore).toEqual(['docs'])
    expect(config.config.watch.enabled).toBe(false)
    expect(config.configFile).toBe(join(directory.realRoot, 'diorama.toml'))

    // And a real mount reports it, with the ignored directory gone from the tree.
    const server = await startDiorama(directory.root)
    try {
      // `startDiorama` resolves on the URL line; the `config:` line follows it,
      // so poll rather than assume the process has finished printing.
      await expect.poll(() => server.output()).toContain(`config: ${join(directory.realRoot, 'diorama.toml')}`)
      // The page's own boot payload carries the effective configuration: this
      // is the same object the file tree's `ignore` comes from.
      const manifest = (await (await fetch(`${server.url}plugin.json`)).json()) as {
        config?: { ignore: string[]; watch: { enabled: boolean } }
      }
      expect(manifest.config?.ignore).toEqual(['docs'])
      expect(manifest.config?.watch.enabled).toBe(false)
    } finally {
      await server.stop()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})

test('2. without --dir the write goes to $DIORAMA_HOME, never into a browsed directory', async () => {
  const home = stateHome()
  const directory = fixture()
  try {
    const set = await diorama(home, ['config', 'set', '--port', '0', '--ignore', '.git'])
    expect(set.code).toBe(0)
    expect(existsSync(join(home, 'diorama.toml'))).toBe(true)
    // Browsing never writes into the served directory (architecture.md §8).
    expect(existsSync(join(directory.root, 'diorama.toml'))).toBe(false)

    const show = await diorama(home, ['config', 'show', directory.root])
    expect(show.stdout).toContain(`config file: ${join(home, 'diorama.toml')}`)
    expect(show.stdout).toContain('ignore = .git')
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})

test('3. config unset drops a field; an emptied file means defaults again', async () => {
  const home = stateHome()
  const directory = fixture()
  try {
    expect((await diorama(home, ['config', 'set', '--dir', directory.root, '--port', '4242'])).code).toBe(0)
    const unset = await diorama(home, ['config', 'unset', 'port', '--dir', directory.root])
    expect(unset.code).toBe(0)
    expect(readFileSync(join(directory.root, 'diorama.toml'), 'utf8')).toBe('')

    // The file still exists (it now says "nothing chosen"), so `show` names it
    // and reports the defaults — an empty file is not a missing file.
    const show = await diorama(home, ['config', 'show', directory.root])
    expect(show.stdout).toContain(`config file: ${join(directory.realRoot, 'diorama.toml')}`)
    expect(show.stdout).toContain('port = 0')
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})

test('4. the wizard offers candidates and only the answered fields land in the file', async () => {
  const home = stateHome()
  const directory = fixture()
  try {
    // Answers in order: host (menu → row 2, "every IPv4 interface"), port
    // (typed), plugins (menu, keep), ignore (menu, free text), watch.enabled
    // (menu → row 2), the two numbers (typed), then the confirmation.
    const answers = ['2', '', '', 'docs, *.log', '2', '', '', 'y', ''].join('\n')
    const wizard = await diorama(home, ['config', '--dir', directory.root], { input: answers })
    expect(wizard.code).toBe(0)
    // The menu shows the loopback default and the "every interface" row.
    expect(wizard.stdout).toContain('host — where the page listens')
    expect(wizard.stdout).toContain('127.0.0.1')
    expect(wizard.stdout).toContain('0.0.0.0')
    // Numeric fields stay plain questions: a typed number is the value.
    expect(wizard.stdout).toContain('watch.debounceMs [300]')
    expect(wizard.stdout).toContain('changes:')
    // `mergeConfig` is what the reader sees today: the default host is the
    // "before" of the first change, so the summary reads as a transition.
    expect(wizard.stdout).toMatch(/host: 127\.0\.0\.1 .* 0\.0\.0\.0/)
    expect(wizard.stdout).toContain(`wrote ${join(directory.realRoot, 'diorama.toml')}`)

    const written = readFileSync(join(directory.root, 'diorama.toml'), 'utf8')
    expect(written).toBe('host = "0.0.0.0"\nignore = [ "docs", "*.log" ]\n\n[watch]\nenabled = false\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})

test('4b. the menus list this machine\'s addresses and toggle pieces by number', async () => {
  const home = stateHome()
  const directory = fixture()
  try {
    // host: keep. port: keep. plugins: toggle rows 1 and 2 off. ignore: "none".
    // watch.enabled: keep. numbers: keep. confirm.
    const answers = ['', '', '1,2', 'none', '', '', '', 'y', ''].join('\n')
    const wizard = await diorama(home, ['config', '--dir', directory.root], { input: answers })
    expect(wizard.code).toBe(0)
    expect(wizard.stdout).toContain('plugins — client pieces, in boot order')
    expect(wizard.stdout).toContain('slots')

    const written = readFileSync(join(directory.root, 'diorama.toml'), 'utf8')
    // Toggling the first two pieces off leaves the rest in boot order.
    expect(written).toContain('plugins = [ "file-tree"')
    expect(written).not.toContain('"slots"')
    expect(written).not.toContain('"layout"')
    // "none" is the explicit empty list, which means "hide nothing".
    expect(written).toContain('ignore = []')
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})

test('4c. a number that is not on the menu is a typo, and the wizard re-asks', async () => {
  const home = stateHome()
  const directory = fixture()
  try {
    // host: 99 (not on the list) then 2; the rest keep.
    const answers = ['99', '2', '', '', '', '', '', '', 'y', ''].join('\n')
    const wizard = await diorama(home, ['config', '--dir', directory.root], { input: answers })
    expect(wizard.code).toBe(0)
    expect(wizard.stdout).toContain('is not on this list')
    expect(readFileSync(join(directory.root, 'diorama.toml'), 'utf8')).toBe('host = "0.0.0.0"\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})

test('5. the wizard writes nothing when the confirmation is declined or input ends', async () => {
  const home = stateHome()
  const directory = fixture()
  try {
    const declined = await diorama(home, ['config', '--dir', directory.root], {
      input: ['', '8080', '', '', '', '', '', 'n', ''].join('\n'),
    })
    expect(declined.code).toBe(0)
    expect(declined.stdout).toContain('not written')
    expect(existsSync(join(directory.root, 'diorama.toml'))).toBe(false)

    // End of input mid-way is an error, not a half-written file.
    const ended = await diorama(home, ['config', '--dir', directory.root], { input: '\n' })
    expect(ended.code).toBe(2)
    expect(ended.stderr).toContain('input ended before the wizard finished')
    expect(existsSync(join(directory.root, 'diorama.toml'))).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})

test('6. a written file that the reader would reject is refused before the disk is touched', async () => {
  const home = stateHome()
  const directory = fixture()
  try {
    writeFileSync(join(directory.root, 'diorama.toml'), 'prot = 1\n')
    // `unset` does not parse the file (it only drops keys), so the refusal
    // comes from the read-modify-write path: `set` cannot preserve a file it
    // cannot read, and says so instead of overwriting it.
    const broken = await diorama(home, ['config', 'set', '--dir', directory.root, '--port', '8080'])
    expect(broken.code).toBe(2)
    expect(broken.stderr).toContain('unknown key "prot"')
    // The user's broken file is left exactly as it was.
    expect(readFileSync(join(directory.root, 'diorama.toml'), 'utf8')).toBe('prot = 1\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})

test('7. a short-lived CLI process keeps the file it wrote (nothing else writes it)', async () => {
  // A guard against "the command wrote to a temporary copy": a detached spawn
  // with the same arguments must see the same file afterwards.
  const home = stateHome()
  const directory = fixture()
  try {
    const child = spawn(process.execPath, [cli, 'config', 'set', '--dir', directory.root, '--port', '5050'], {
      cwd: repoRoot,
      stdio: 'ignore',
      env: { ...process.env, DIORAMA_HOME: home },
    })
    const code = await new Promise<number | null>(done => child.on('exit', done))
    expect(code).toBe(0)
    expect(readFileSync(join(directory.root, 'diorama.toml'), 'utf8')).toBe('port = 5050\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})
