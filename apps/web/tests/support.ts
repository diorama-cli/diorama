/**
 * Test support for the M0 acceptance suite (docs/plan.md): start the real CLI
 * against a generated directory and talk to it over HTTP.
 */
import { spawn, type ChildProcess } from 'node:child_process'
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
    'README.md': 'hello diorama\nsecond line\n',
    'docs/notes.md': '# Notes\n\nbody\n',
    'src/app.js': 'console.log("hi")\n',
    ...files,
  }
  for (const [path, text] of Object.entries(contents)) {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text)
  }
  return {
    // The server resolves symlinks (`diorama` mounts realpath), so compare real paths.
    root,
    realRoot: realpathSync(root),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
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
