import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { fixture, listOverRpc, repoRoot, startDiorama } from './support.ts'

/**
 * M2 S1 (docs/m2/spec.md §4 rows 1–3, contract.md §4.1): `diorama.toml` is
 * located, merged under the CLI, and its `ignore` list hides entries from
 * `fs.list` — which is where the file tree reads directories.
 */
const run = promisify(execFile)
const cli = join(repoRoot, 'packages/cli/bin/diorama')

async function dumpConfig(dir: string, args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [cli, dir, '--dump-config', ...args], { cwd: repoRoot })
    return { stdout, code: 0 }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, code: failure.code ?? 1 }
  }
}

test('1. diorama.toml is found, validated, and the CLI overrides it', async () => {
  const directory = fixture()
  try {
    writeFileSync(join(directory.root, 'diorama.toml'), ['host = "127.0.0.1"', 'port = 4444', 'ignore = ["secret"]'].join('\n'))
    const fromFile = await dumpConfig(directory.root, [])
    expect(fromFile.code).toBe(0)
    const parsed = JSON.parse(fromFile.stdout) as { config: { port: number; ignore: string[] }; configFile: string | null }
    expect(parsed.config.port).toBe(4444)
    expect(parsed.config.ignore).toEqual(['secret'])
    expect(parsed.configFile).toBe(join(directory.realRoot, 'diorama.toml'))

    const overridden = await dumpConfig(directory.root, ['--port', '0', '--all'])
    const merged = JSON.parse(overridden.stdout) as { config: { port: number; ignore: string[] } }
    expect(merged.config.port).toBe(0)
    expect(merged.config.ignore).toEqual([])

    const noFile = await dumpConfig(directory.root, [])
    expect(noFile.code).toBe(0)
  } finally {
    directory.dispose()
  }
})

test('2. a broken diorama.toml fails loud with exit code 2 and names the reason', async () => {
  const directory = fixture()
  try {
    writeFileSync(join(directory.root, 'diorama.toml'), 'port = \n')
    const broken = await dumpConfig(directory.root, [])
    expect(broken.code).toBe(2)
    expect(broken.stdout).toContain('diorama.toml: invalid TOML')

    writeFileSync(join(directory.root, 'diorama.toml'), 'prot = 8080\n')
    const unknown = await dumpConfig(directory.root, [])
    expect(unknown.code).toBe(2)
    expect(unknown.stdout).toContain('unknown key "prot"')
  } finally {
    directory.dispose()
  }
})

test('3. ignored entries are absent from the tree and from fs.list', async ({ page }) => {
  const directory = fixture()
  mkdirSync(join(directory.root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(directory.root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  mkdirSync(join(directory.root, '.git'))
  writeFileSync(join(directory.root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(directory.root, 'notes.log'), 'debug\n')
  writeFileSync(join(directory.root, 'diorama.toml'), 'ignore = ["node_modules", ".git", "*.log"]\n')
  const server = await startDiorama(directory.root)
  try {
    await page.goto(server.url)
    const tree = page.getByTestId('file-tree')
    await expect(tree.locator('[data-path="README.md"]')).toBeVisible()
    await expect(tree.locator('[data-path="node_modules"]')).toHaveCount(0)
    await expect(tree.locator('[data-path=".git"]')).toHaveCount(0)
    await expect(tree.locator('[data-path="notes.log"]')).toHaveCount(0)

    // The single enforcement point: `fs.list` itself hides them (contract §3.1).
    const listed = await listOverRpc(page, server.url, '')
    expect(listed.sort()).toEqual(['LICENSE', 'README.md', 'blob.bin', 'diorama.toml', 'docs', 'src'])
  } finally {
    await server.stop()
    directory.dispose()
  }
})

test('3b. --all shows the default-hidden directories again', async ({ page }) => {
  const directory = fixture()
  mkdirSync(join(directory.root, 'node_modules'))
  writeFileSync(join(directory.root, 'node_modules', 'x.js'), 'x\n')
  const server = await startDiorama(directory.root, ['--all'])
  try {
    await page.goto(server.url)
    await expect(page.getByTestId('file-tree').locator('[data-path="node_modules"]')).toBeVisible()
  } finally {
    await server.stop()
    directory.dispose()
  }
})
