import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fixture, repoRoot } from './support.ts'
import { join } from 'node:path'

/**
 * M2 regression: one module serves both halves of a plugin, so a client-only
 * kernel service (`ctx.commands`, `ctx.mount`) may not break the *server* tree.
 * The CLI must boot every built-in plugin without a failure, recording that
 * those halves start cleanly instead of being silently skipped.
 */
const run = promisify(execFile)

test('every built-in plugin boots on the server too (no half fails)', async () => {
  const directory = fixture()
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [join(repoRoot, 'packages/cli/bin/diorama-beta'), directory.root, '--port', '0', '--dump-plan'],
      { cwd: repoRoot, timeout: 15_000 },
    )
    expect(stdout).toContain('"plugins"')
    // Plan rendering itself must not complain about any plugin.
    expect(stderr).not.toMatch(/diorama:/)
  } finally {
    directory.dispose()
  }
})

test('a real server boot reports no plugin failures', async ({ page }) => {
  const directory = fixture()
  // `--foreground`: this test owns a server process and reads its console, so
  // it uses the in-process gateway form (a daemon would write to gateway.log).
  const home = mkdtempSync(join(tmpdir(), 'diorama-halves-'))
  const { spawn } = await import('node:child_process')
  const child = spawn(
    process.execPath,
    [join(repoRoot, 'packages/cli/bin/diorama-beta'), directory.root, '--port', '0', '--foreground'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DIORAMA_HOME: home } },
  )
  let output = ''
  child.stdout.on('data', chunk => (output += String(chunk)))
  child.stderr.on('data', chunk => (output += String(chunk)))
  try {
    await expect.poll(() => output, { timeout: 15_000 }).toMatch(/http:\/\/\S+\//)
    const url = output.match(/http:\/\/\S+\//)?.[0] ?? ''
    await page.goto(url)
    // Give the server tree a moment to report any late failure.
    await page.waitForTimeout(300)
    expect(output).not.toMatch(/plugin\(s\) failed/)
    expect(output).not.toMatch(/did not activate/)
    expect(output).not.toMatch(/cannot get property/)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>(done => child.on('exit', () => done()))
    rmSync(home, { recursive: true, force: true })
    directory.dispose()
  }
})
