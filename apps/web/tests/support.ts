/**
 * Test support for the M0 acceptance suite (docs/plan.md): start the real CLI
 * against a generated directory and talk to it over HTTP.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
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


/** A resident gateway on a throwaway `DIORAMA_HOME` (contract.md §7). */
export interface GatewayFixture {
  /** The state directory (`diorama.sock`, `gateway.pid`, `gateway.log`). */
  home: string
  socket: string
  output(): string
  /** Mount a directory over the control plane and wait for its status. */
  mount(dir: string, extra?: Record<string, unknown>): Promise<MountStatus>
  /** One control request (raw NDJSON, contract.md §7.2). */
  request(method: string, params?: Record<string, unknown>): Promise<unknown>
  stop(): Promise<void>
}

/** What the control plane reports for one mount (contract.md §7.3). */
export interface MountStatus {
  mountId: string
  root: string
  port: number
  url: string
  state: 'starting' | 'ok' | 'degraded' | 'stopped'
  created?: boolean
  configFile?: string
  plugins: string[]
  hidden: string[]
}

/** The effective configuration a real CLI sends before mounting (contract defaults). */
export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 0,
  plugins: ['slots', 'layout', 'file-tree', 'tabs', 'renderer-registry', 'plaintext', 'markdown', 'code', 'palette'],
  ignore: ['.git', 'node_modules'],
  watch: { debounceMs: 300, enabled: true },
}

/** Send one control request and resolve with its result (or reject with its code). */
export function controlRequest(socket: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = connect(socket)
    connection.setEncoding('utf8')
    let buffer = ''
    const frame = `${JSON.stringify({ type: 'request', id: 1, method, params })}\n`
    connection.on('connect', () => connection.write(frame))
    connection.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const response = JSON.parse(buffer.slice(0, newline)) as { result?: unknown; code?: string; message?: string }
      connection.destroy()
      if (response.code !== undefined) reject(new Error(`${response.code}: ${response.message ?? ''}`))
      else resolve(response.result)
    })
    connection.on('error', reject)
  })
}

/** Start `diorama gateway run` on a temp state directory and wait for the socket. */
export async function startGateway(): Promise<GatewayFixture> {
  const home = mkdtempSync(join(tmpdir(), 'diorama-gateway-'))
  const child: ChildProcess = spawn(process.execPath, [cli, 'gateway', 'run'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DIORAMA_HOME: home },
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const socket = join(home, 'diorama.sock')
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`gateway did not start in time:\n${output}`)), 15_000)
    child.on('exit', code => {
      clearTimeout(timer)
      fail(new Error(`gateway exited (${code ?? '?'}):\n${output}`))
    })
    void (async function poll() {
      await new Promise(done => setTimeout(done, 50))
      try {
        await controlRequest(socket, 'ping')
        clearTimeout(timer)
        ready()
      } catch {
        void poll()
      }
    })()
  })
  const request = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => controlRequest(socket, method, params)
  return {
    home,
    socket,
    output: () => output,
    request,
    async mount(dir, extra = {}) {
      const status = (await request('mount', { root: dir, config: DEFAULT_CONFIG, ...extra })) as MountStatus
      return status
    },
    stop: async () => {
      await request('stop').catch(() => {})
      await new Promise<void>(done => {
        if (child.exitCode !== null) return done()
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          done()
        }, 5_000)
        child.on('exit', () => {
          clearTimeout(timer)
          done()
        })
      })
      rmSync(home, { recursive: true, force: true })
    },
  }
}
