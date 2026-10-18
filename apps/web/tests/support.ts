/**
 * Test support for the M0 acceptance suite (docs/plan.md): start the real CLI
 * against a generated directory and talk to it over HTTP.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Repository root (apps/web/tests → ../..). */
export const repoRoot = resolve(import.meta.dirname, '../../..')
const cli = join(repoRoot, 'packages/cli/bin/diorama')

export interface Fixture {
  root: string
  /** The same directory after symlink resolution (what the server reports). */
  realRoot: string
  dispose(): void
}

/** A small directory tree with one nested file and one binary file. */
export function fixture(files: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'diorama-test-'))
  const contents = {
    'README.md': '# Readme\n\n- first\n- second\n',
    'docs/notes.md': '# Notes\n\nbody\n',
    'src/app.js': 'function hi() {\n  return "hi"\n}\n',
    LICENSE: 'plain text license\n',
    ...files,
  }
  for (const [path, text] of Object.entries(contents)) {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text)
  }
  // A file with NUL bytes: `ctx.fs.readText` refuses it as binary (EBINARY).
  writeFileSync(join(root, 'blob.bin'), new Uint8Array(Array.from({ length: 200 }, (_, index) => index % 251)))
  return {
    // The server resolves symlinks (`diorama` mounts realpath), so compare real paths.
    root,
    realRoot: realpathSync(root),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** What a test needs from the page's mount handle (`mountCtx`). */
export interface PageMount {
  fs: {
    list(path?: string): Promise<{ name: string; path: string; kind: string; size: number }[]>
    stat(path: string): Promise<{ path: string; kind: string; size: number }>
    readBytes(path: string): Promise<Uint8Array>
    readText(path: string): Promise<string>
  }
  rpc: { call(method: string, ...args: unknown[]): Promise<unknown> }
}

/**
 * The page's mount handle. Declared for `page.evaluate`, which type-checks
 * globals: the shell exposes it through the page bridge (contract.md §8).
 */
export function pageMount(): PageMount | undefined {
  const bridge = (globalThis as unknown as {
    __diorama_page__?: { getKernel(): { mount: PageMount } | undefined }
  }).__diorama_page__
  return bridge?.getKernel()?.mount
}

/** Wait until the shell installed its page kernel (it boots asynchronously). */
export async function waitForPage(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const bridge = (window as unknown as {
      __diorama_page__?: { getKernel(): unknown }
    }).__diorama_page__
    return bridge?.getKernel() !== undefined
  })
}

/**
 * List a directory through the page's own `mountCtx.fs` (contract.md §4: files
 * travel over RPC; the M0 `/api/fs/*` HTTP routes are gone).
 */
export async function listOverRpc(page: Page, url: string, path: string): Promise<string[]> {
  await page.goto(url)
  // The page boots asynchronously; wait until the kernel is installed.
  await waitForPage(page)
  return await page.evaluate(async (dir: string) => {
    const bridge = (window as unknown as {
      __diorama_page__?: { getKernel(): { mount: { fs: { list(p?: string): Promise<{ name: string }[]> } } } | undefined }
    }).__diorama_page__
    const mount = bridge?.getKernel()?.mount
    if (mount === undefined) throw new Error('the page did not boot')
    const entries = await mount.fs.list(dir)
    return entries.map(entry => entry.name)
  }, path)
}

export interface Diorama {
  url: string
  port: number
  output(): string
  stop(): Promise<void>
}

/** Start `diorama <dir>` on a free port and resolve once it prints its URL. */
export async function startDiorama(dir: string, args: string[] = []): Promise<Diorama> {
  const child: ChildProcess = spawn(process.execPath, [cli, dir, '--port', '0', ...args], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`diorama did not start in time:\n${output}`)), 15_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = output.match(/http:\/\/[^\s]+\//)
      if (match !== null) {
        clearTimeout(timer)
        resolveUrl(match[0])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`diorama exited (${code ?? '?'}):\n${output}`))
    })
  })
  return {
    url,
    port: new URL(url).port === '' ? 80 : Number(new URL(url).port),
    output: () => output,
    stop: () =>
      new Promise<void>(done => {
        if (child.exitCode !== null) {
          done()
          return
        }
        child.on('exit', () => done())
        child.kill('SIGTERM')
      }),
  }
}
