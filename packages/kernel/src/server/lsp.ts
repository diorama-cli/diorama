/**
 * `ctx.lsp` server half: a **read-only** Language Server Protocol client, one
 * server process per mount (contract.md §3.12).
 *
 * Why this lives in the kernel and not in a plugin: a plugin may not
 * `import 'node:fs'` (AGENTS.md §6, architecture.md §8), and an LSP client
 * necessarily spawns a process and speaks over its pipes. The same reason
 * `ctx.git` shells out to git — the process boundary is the kernel's job,
 * reading the answer is anyone's.
 *
 * Only the read-only half of the protocol is forwarded. `rename`,
 * `workspace/applyEdit`, `executeCommand` and friends are **never** called:
 * diorama does not write the directory it is looking at (architecture.md §13),
 * and a language server that could is a second write path nobody audited.
 *
 * ## Where the server writes
 *
 * A language server wants a cache (clangd's background index, gopls's module
 * cache). Writing it into the browsed directory would break the read-only
 * rule, so the cache root is `/tmp/diorama/.cache/lsp/<normalised project>`
 * and each server is pointed at it:
 *
 * - clangd: `--compile-commands-dir=<cache>`, which moves both the compile
 *   database lookup and `.cache/clangd/index` there (measured: the project
 *   stays untouched, definitions still resolve — docs/m33/spec.md §6);
 * - tsserver / gopls: `XDG_CACHE_HOME` and `GOCACHE` are redirected.
 *
 * ## Failure is not an error
 *
 * A mount whose language is unsupported, whose server is not installed and
 * cannot be installed, or whose server died, answers "no" rather than throwing
 * on every hover: the page asks `status()` first and simply does not offer a
 * jump. This mirrors `ctx.git`'s "no repository, no service" (contract.md §3.2).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fsError, rpcError } from '../shared/errors.ts'
import {
  fromLspRange,
  languageOfPath,
  toLsp,
  type LspHover,
  type LspLocation,
  type LspPosition,
  type LspServerInfo,
  type LspSymbol,
} from '../shared/lsp.ts'
import type { MethodDescriptor } from '../shared/rpc.ts'
import type { RelPath } from '../shared/types.ts'
import type { FsService } from './fs.ts'
import type { Mounts } from './plugins.ts'

declare module 'cordis' {
  interface Context {
    /** Read-only language intelligence. Present on mount contexts with a server. */
    lsp: LspService
  }
}

/** Where every language server's cache goes (never into the browsed directory). */
export const LSP_CACHE_ROOT = '/tmp/diorama/.cache/lsp'

/** How long `initialize` may take before the server counts as unavailable. */
export const LSP_INIT_TIMEOUT_MS = 30_000

/** How long one query may take. A first `definition` builds the project index. */
export const LSP_REQUEST_TIMEOUT_MS = 20_000

/** How long an on-demand `pnpm add` may take. */
export const LSP_INSTALL_TIMEOUT_MS = 120_000

/**
 * How long the first query of a language may wait for the project to load.
 * Measured: tsserver finishes "Initializing JS/TS language features…" in a
 * few hundred ms on a small project and a couple of seconds on a real one.
 */
export const LSP_WARMUP_TIMEOUT_MS = 15_000

/** How long to wait between two confirmation asks of the first query. */
export const LSP_SETTLE_MS = 250

/** How many times the first query of a language is confirmed (see {@link LspService.locations}). */
export const LSP_CONFIRM_ATTEMPTS = 8

const METHODS: MethodDescriptor[] = [
  { name: 'status', arity: 0 },
  { name: 'definition', arity: 3 },
  { name: 'typeDefinition', arity: 3 },
  { name: 'references', arity: 3 },
  { name: 'hover', arity: 3 },
  { name: 'documentSymbol', arity: 2 },
]

/**
 * One normalised directory name for a project path, so two mounts of the same
 * directory share a cache and two different ones never collide.
 */
export function cacheDirFor(projectPath: string): string {
  // A dash in a directory name must not look like a separator (\`/a-b\` and
  // \`/a/b\` are different projects), so the separator becomes a character a
  // path cannot contain, and existing dashes are doubled first.
  const flat = projectPath
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+$/, '')
    .replace(/-/g, '--')
    .replace(/[\\/]+/g, '-')
  return join(LSP_CACHE_ROOT, flat === '' ? 'root' : flat)
}

/** One frame of the wire format: a header block and a JSON body. */
interface Frame {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * The stdio transport: `Content-Length` framing over a child's pipes.
 *
 * Requests are numbered and answered by id. Server → client *requests*
 * (`workspace/configuration`, `client/registerCapability`, …) are answered with a
 * null result: a server that never hears back stalls, and "the first hover
 * works and then nothing does" is the symptom (measured — docs/m33/spec.md §6).
 */
class LspConnection {
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private closed = false
  /**
   * Progress tokens the server opened and has not closed (`$/progress` with
   * `begin` … `end`). While one is open the server is still loading the
   * project, and an answer it gives now is provisional — see
   * {@link LspService.locations}.
   */
  private readonly busy = new Set<string>()

  /** The process this connection speaks to. */
  private readonly child: ChildProcessWithoutNullStreams

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => {
      this.read(chunk)
    })
    child.on('exit', () => {
      this.closed = true
      this.failAll(new Error('the language server exited'))
    })
    child.on('error', (error: Error) => {
      this.closed = true
      this.failAll(error)
    })
  }

  /** Whether the process is still answering. */
  get alive(): boolean {
    return !this.closed
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (match === null) {
        // A frame without a length cannot be framed; drop the header and go on.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      let frame: Frame
      try {
        frame = JSON.parse(body) as Frame
      } catch {
        continue
      }
      this.handle(frame)
    }
  }

  private handle(frame: Frame): void {
    if (frame.id !== undefined && frame.method === undefined) {
      const waiting = this.pending.get(Number(frame.id))
      if (waiting === undefined) return
      this.pending.delete(Number(frame.id))
      clearTimeout(waiting.timer)
      if (frame.error !== undefined) waiting.reject(new Error(frame.error.message))
      else waiting.resolve(frame.result)
      return
    }
    // A server → client request: answer it, or the server waits forever.
    if (frame.id !== undefined && frame.method !== undefined) {
      const result = frame.method === 'workspace/configuration' ? [] : null
      this.write({ jsonrpc: '2.0', id: frame.id, result })
      return
    }
    if (frame.method === '$/progress') {
      this.trackProgress(frame.params)
      return
    }
    // Any other notification (diagnostics, logs): nothing to do with it here.
  }

  /** Follow `$/progress`: `begin` opens a token, `end` closes it. */
  private trackProgress(params: unknown): void {
    if (params === null || typeof params !== 'object') return
    const update = params as { token?: unknown; value?: { kind?: unknown } }
    const token = typeof update.token === 'string' ? update.token : undefined
    if (token === undefined) return
    const kind = update.value?.kind
    if (kind === 'begin') this.busy.add(token)
    else if (kind === 'end') this.busy.delete(token)
  }

  /** Whether the server says it is still working. */
  get working(): boolean {
    return this.busy.size > 0
  }

  /** Wait until the server is idle, or `timeoutMs` passes (never throws). */
  async whenIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.working && !this.closed && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        setTimeout(resolve, 50)
      })
    }
  }

  private failAll(error: Error): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
    }
    this.pending.clear()
  }

  write(frame: Frame): void {
    if (this.closed) return
    const body = JSON.stringify(frame)
    this.child.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body)
  }

  request(method: string, params: unknown, timeoutMs = LSP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('the language server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(method + ' timed out after ' + timeoutMs + 'ms'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.request('shutdown', null, 2_000)
    } catch {
      // A server that will not shut down politely is killed below.
    }
    this.notify('exit', null)
    this.closed = true
    this.failAll(new Error('the language server was closed'))
    // Give it a moment to leave, then insist: an orphan tsserver per mount is
    // how a gateway ends up with a hundred processes.
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL')
        resolve()
      }, 500)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/** How to launch one language, and what the page should call it. */
interface ServerSpec {
  language: string
  /** The executable as it is spawned (an absolute path after an install). */
  command: string
  args: string[]
  /** Extra environment for the process. */
  env: NodeJS.ProcessEnv
}

/**
 * What an on-demand TypeScript install brings: the adapter **and** the compiler
 * it drives.
 *
 * `tsserver` itself does **not** speak LSP (measured: `initialize` over stdio
 * never answers), so the adapter is required — and the adapter is only a
 * wrapper: without a `typescript` package beside it, it exits with "provides
 * no tsserver.js" and every hover is empty. Both are installed together.
 */
const TYPESCRIPT_SERVER_PACKAGE = 'typescript-language-server'
/**
 * `typescript` is pinned to the **5.x** line on purpose: the 7.x package on
 * this registry is the native preview, which ships no `tsserver.js` — the
 * adapter then exits with "provides no tsserver.js" and every hover is empty
 * (measured, docs/m33/spec.md §6). A project that already has its own
 * TypeScript is unaffected: the server prefers the workspace's copy.
 */
const TYPESCRIPT_PACKAGES = [TYPESCRIPT_SERVER_PACKAGE, 'typescript@5']

/** `true` when `command` is runnable (found on `PATH` or an existing path). */
function onPath(command: string): boolean {
  if (command.includes('/')) return existsSync(command)
  const path = process.env.PATH ?? ''
  return path.split(':').some(dir => dir !== '' && existsSync(join(dir, command)))
}

/** Run a command to completion, resolving with its exit code. */
function run(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd, stdio: 'ignore', env: process.env })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(-1)
    }, timeoutMs)
    child.on('exit', code => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
  })
}

/**
 * Read-only language intelligence for one mounted directory (contract.md §3.12).
 *
 * The server is started **on the first query**, not at mount time: a directory
 * that is only ever looked at as a file tree should not pay for a compiler.
 */
export class LspService {
  private readonly resolveFs: () => FsService
  private readonly root: string
  private readonly cacheDir: string
  /** One connection per language; a mount can hold TS and C files at once. */
  private readonly servers = new Map<string, Promise<LspConnection | undefined>>()
  private readonly info = new Map<string, LspServerInfo>()
  /** Which text the server was last told about, per file, to skip repeats. */
  private readonly opened = new Map<string, string>()
  private readonly installing = new Set<string>()
  /**
   * Languages whose first answer has already been re-asked. See
   * {@link LspService.locations}: a server that is still loading the project
   * answers its first definition from the file it already has open, which is
   * the `import` line rather than the declaration.
   */
  private readonly warmed = new Set<string>()

  constructor(root: string, fs: FsService | (() => FsService)) {
    this.root = root
    this.cacheDir = cacheDirFor(root)
    this.resolveFs = typeof fs === 'function' ? fs : () => fs
  }

  private get fs(): FsService {
    return this.resolveFs()
  }

  describe(): MethodDescriptor[] {
    return METHODS
  }

  /** Which server this mount would use, and whether it is usable (contract.md §3.12). */
  async status(): Promise<LspServerInfo[]> {
    const result: LspServerInfo[] = []
    for (const language of ['typescript', 'c', 'cpp', 'go']) {
      const running = this.info.get(language)
      if (running !== undefined) {
        result.push(running)
        continue
      }
      const spec = this.specFor(language)
      if (spec === undefined) continue
      result.push(
        onPath(spec.command)
          ? { language, command: spec.command, state: 'running' }
          : { language, command: spec.command, state: 'unavailable', reason: spec.command + ' is not installed' },
      )
    }
    return result
  }

  /** Where a definition is declared (contract.md §3.12). */
  async definition(path: RelPath, position: LspPosition, text?: string): Promise<LspLocation[]> {
    return this.locations(path, position, 'textDocument/definition', text)
  }

  /** Where a type is declared. */
  async typeDefinition(path: RelPath, position: LspPosition, text?: string): Promise<LspLocation[]> {
    return this.locations(path, position, 'textDocument/typeDefinition', text)
  }

  /** Every place a symbol is used. */
  async references(path: RelPath, position: LspPosition, text?: string): Promise<LspLocation[]> {
    // `includeDeclaration` belongs **inside** `context` (LSP spec): at the top
    // level the server rejects the whole request with "Cannot read properties
    // of undefined (reading 'includeDeclaration')" and every "find usages"
    // silently answered nothing (docs/m33/spec.md §6).
    return this.locations(path, position, 'textDocument/references', text, {
      context: { includeDeclaration: true },
    })
  }

  /** The hover card's contents. */
  async hover(path: RelPath, position: LspPosition, text?: string): Promise<LspHover | undefined> {
    const connection = await this.connectFor(path)
    if (connection === undefined) return undefined
    await this.sync(path, connection, text)
    const raw = (await connection.request('textDocument/hover', {
      textDocument: { uri: this.uriOf(path) },
      position: toLsp(clampPosition(text ?? (await this.readText(path)) ?? '', position)),
    })) as { contents?: unknown; range?: unknown } | null
    if (raw == null) return undefined
    const contents = hoverText(raw.contents)
    if (contents === '') return undefined
    const range = isRange(raw.range) ? fromLspRange(raw.range) : undefined
    return range === undefined ? { contents } : { contents, range }
  }

  /** The file's outline, as the server gives it. */
  async documentSymbol(path: RelPath, text?: string): Promise<LspSymbol[]> {
    const connection = await this.connectFor(path)
    if (connection === undefined) return []
    await this.sync(path, connection, text)
    const raw = (await connection.request('textDocument/documentSymbol', {
      textDocument: { uri: this.uriOf(path) },
    })) as unknown
    return symbolsOf(raw)
  }

  /** Kill every server this mount started (the mount's disposer). */
  async close(): Promise<void> {
    const closing = [...this.servers.values()]
    this.servers.clear()
    for (const pending of closing) {
      const connection = await pending.catch(() => undefined)
      await connection?.close()
    }
    this.opened.clear()
    this.info.clear()
  }

  // --- internals -----------------------------------------------------------

  private uriOf(path: RelPath): string {
    const encoded = path
      .split('/')
      .filter(segment => segment !== '')
      .map(segment => encodeURIComponent(segment))
      .join('/')
    const absolute = join(this.root, encoded).replace(/\\/g, '/')
    return 'file://' + (absolute.startsWith('/') ? absolute : '/' + absolute)
  }

  /** The mount-relative path of a `file://` URI, or `undefined` when outside the mount. */
  private pathOf(uri: string): RelPath | undefined {
    if (!uri.startsWith('file://')) return undefined
    let absolute: string
    try {
      absolute = decodeURIComponent(uri.slice('file://'.length))
    } catch {
      return undefined
    }
    // macOS resolves /tmp to /private/tmp; compare both spellings.
    const root = this.root.replace(/\/+$/, '')
    const candidates = new Set([root, '/private' + root])
    for (const candidate of candidates) {
      if (absolute === candidate) return ''
      if (absolute.startsWith(candidate + '/')) return absolute.slice(candidate.length + 1)
    }
    return undefined
  }

  /** The launch description for one language, or `undefined` when unclaimed. */
  private specFor(language: string): ServerSpec | undefined {
    switch (language) {
      case 'typescript':
        return {
          language,
          command: 'typescript-language-server',
          args: ['--stdio'],
          env: { XDG_CACHE_HOME: join(this.cacheDir, 'xdg') },
        }
      case 'c':
      case 'cpp':
        return {
          language,
          command: 'clangd',
          // Keeps both the compile database and `.cache/clangd/index` out of the
          // browsed directory (measured — docs/m33/spec.md §6).
          args: ['--log=error', '--compile-commands-dir=' + this.cacheDir],
          env: {},
        }
      case 'go':
        return {
          language,
          command: 'gopls',
          args: [],
          env: { GOCACHE: join(this.cacheDir, 'go-build') },
        }
      default:
        return undefined
    }
  }

  /** The connection for a file's language, starting the server on first use. */
  private async connectFor(path: RelPath): Promise<LspConnection | undefined> {
    const language = languageOfPath(path)
    if (language === undefined) return undefined
    const existing = this.servers.get(language)
    if (existing !== undefined) return await existing
    const started = this.start(language)
    this.servers.set(language, started)
    return await started
  }

  private async start(language: string): Promise<LspConnection | undefined> {
    const spec = this.specFor(language)
    if (spec === undefined) return undefined
    let command = spec.command
    if (!onPath(command)) {
      command = await this.install(language)
      if (command === '') {
        this.info.set(language, {
          language,
          command: spec.command,
          state: 'unavailable',
          reason: spec.command + ' is not installed and could not be installed',
        })
        return undefined
      }
    }
    try {
      await mkdir(this.cacheDir, { recursive: true })
    } catch {
      // A cache directory that cannot be made is not fatal: the server writes
      // where it would have anyway.
    }
    const child = spawn(command, spec.args, {
      cwd: this.cacheDir,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const connection = new LspConnection(child)
    // clangd complains on stderr about a missing compile database; leaving the
    // pipe unread would eventually block it.
    child.stderr.resume()
    try {
      await connection.request(
        'initialize',
        {
          processId: process.pid,
          rootUri: this.uriOf(''),
          capabilities: {
            textDocument: {
              definition: { linkSupport: true },
              typeDefinition: { linkSupport: true },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              references: {},
            },
            workspace: { configuration: true, workspaceFolders: true },
          },
          workspaceFolders: [{ uri: this.uriOf(''), name: 'mount' }],
        },
        LSP_INIT_TIMEOUT_MS,
      )
      connection.notify('initialized', {})
      this.info.set(language, { language, command, state: 'running' })
      return connection
    } catch (error) {
      this.info.set(language, { language, command, state: 'unavailable', reason: (error as Error).message })
      await connection.close()
      return undefined
    }
  }

  /**
   * Install a missing TypeScript server into the cache root (the reader's
   * choice: "auto `pnpm add`"). Returns the command to spawn, or '' when the
   * install failed. Nothing is written into the browsed directory.
   */
  private async install(language: string): Promise<string> {
    if (language !== 'typescript' || this.installing.has(language)) return ''
    this.installing.add(language)
    this.info.set(language, { language, command: TYPESCRIPT_SERVER_PACKAGE, state: 'installing' })
    try {
      const dir = join(this.cacheDir, 'server')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'diorama-lsp', private: true }, null, 2))
      const code = await run('pnpm', ['add', ...TYPESCRIPT_PACKAGES], dir, LSP_INSTALL_TIMEOUT_MS)
      if (code !== 0) return ''
      const binary = join(dir, 'node_modules', '.bin', TYPESCRIPT_SERVER_PACKAGE)
      return existsSync(binary) ? binary : ''
    } catch {
      return ''
    } finally {
      this.installing.delete(language)
    }
  }

  /**
   * Tell the server what this file currently is. `text` is the page's own
   * buffer — a diff view draws a file it does not have on disk, and a language
   * server answers happily about a buffer it was given (measured, docs/m33/
   * spec.md §6). Without `text` the file is read through `ctx.fs`, which keeps the
   * read-only rule and the mount's limits in one place.
   */
  private async sync(path: RelPath, connection: LspConnection, text?: string): Promise<void> {
    const language = languageOfPath(path)
    const body = text ?? (await this.readText(path))
    if (body === undefined) throw fsError('ENOENT', 'cannot read ' + path + ' for the language server')
    const uri = this.uriOf(path)
    const previous = this.opened.get(path)
    if (previous === body) return
    this.opened.set(path, body)
    if (previous === undefined) {
      connection.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: language, version: 1, text: body },
      })
      return
    }
    connection.notify('textDocument/didChange', {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: body }],
    })
  }

  /** The file's text through `ctx.fs` (absent for binary or oversized files). */
  private async readText(path: RelPath): Promise<string | undefined> {
    try {
      const result = (await this.fs.readText(path)) as unknown
      return typeof result === 'string' ? result : undefined
    } catch {
      return undefined
    }
  }

  private async locations(
    path: RelPath,
    position: LspPosition,
    method: string,
    text?: string,
    extra: Record<string, unknown> = {},
  ): Promise<LspLocation[]> {
    const connection = await this.connectFor(path)
    if (connection === undefined) {
      throw rpcError('ESERVICE', 'no language server for this file; lsp is unavailable')
    }
    await this.sync(path, connection, text)
    const ask = async (): Promise<LspLocation[]> => {
      // Clamped against the very text the server was given: a position it
      // cannot place kills the server (see `clampPosition`).
      const body = text ?? (await this.readText(path)) ?? ''
      const raw = (await connection.request(method, {
        textDocument: { uri: this.uriOf(path) },
        position: toLsp(clampPosition(body, position)),
        ...extra,
      })) as unknown
      return locationsOf(raw, uri => this.pathOf(uri))
    }
    const language = languageOfPath(path)
    if (language === undefined || this.warmed.has(language)) return await ask()
    // The first query of a freshly started server is answered **provisionally**:
    // while the project is still loading, a definition is resolved against the
    // one file that is open, so `add` points at its own `import` line instead
    // of the declaration. `$/progress` says when loading is over, but an answer
    // that arrives inside the last tick is still provisional — so the first
    // answer is confirmed by asking again until two consecutive answers agree
    // (measured: 2.5 s then 6 ms, docs/m33/spec.md §6).
    await connection.whenIdle(LSP_WARMUP_TIMEOUT_MS)
    this.warmed.add(language)
    let previous = await ask()
    for (let attempt = 0; attempt < LSP_CONFIRM_ATTEMPTS; attempt++) {
      await new Promise<void>(resolve => {
        setTimeout(resolve, LSP_SETTLE_MS)
      })
      const current = await ask()
      if (sameLocations(previous, current)) return current
      previous = current
    }
    return previous
  }
}

/**
 * Bring a position inside the text it refers to.
 *
 * **A language server crashes on a position it cannot place.** Measured on
 * tsserver 5.9.3: a column past the end of the line makes it throw
 * `Debug Failure. False expression` inside `computePositionOfLineAndCharacter`, which
 * kills the whole server — every later request on that mount then fails, and
 * the page has lost the feature for a file it never touched (docs/m33/spec.md
 * §6).
 *
 * The page's column can be past the end for honest reasons: a click in the
 * empty area right of a short line, a diff row whose text is shorter than the
 * line it came from, a stale buffer. Clamping is the only safe answer.
 */
export function clampPosition(
  text: string,
  position: { line: number; character: number },
): { line: number; character: number } {
  const lines = text.split('\n')
  const last = Math.max(1, lines.length)
  const line = Math.min(Math.max(1, Math.trunc(position.line)), last)
  const source = lines[line - 1] ?? ''
  const character = Math.min(Math.max(0, Math.trunc(position.character)), source.length)
  return { line, character }
}

/** Whether two definition answers say the same places. */
export function sameLocations(a: readonly LspLocation[], b: readonly LspLocation[]): boolean {
  if (a.length !== b.length) return false
  return a.every((location, index) => {
    const other = b[index]
    if (other === undefined) return false
    return (
      location.path === other.path &&
      location.range.start.line === other.range.start.line &&
      location.range.start.character === other.range.start.character
    )
  })
}

/** Whether a value looks like an LSP range. */
export function isRange(
  value: unknown,
): value is { start: { line: number; character: number }; end: { line: number; character: number } } {
  if (value === null || typeof value !== 'object') return false
  const range = value as { start?: unknown; end?: unknown }
  return (
    typeof range.start === 'object' &&
    range.start !== null &&
    typeof range.end === 'object' &&
    range.end !== null &&
    typeof (range.start as { line?: unknown }).line === 'number' &&
    typeof (range.end as { line?: unknown }).line === 'number'
  )
}

/**
 * A definition answer, in either shape: `Location[]` (the common one) or
 * `LocationLink[]` (what `linkSupport` asks for). Locations outside the mount
 * — a `node_modules` declaration, `/usr/include` — are dropped, because the
 * page can only open what the mount serves.
 */
export function locationsOf(raw: unknown, pathOf: (uri: string) => RelPath | undefined): LspLocation[] {
  if (raw === null || raw === undefined) return []
  const list = Array.isArray(raw) ? raw : [raw]
  const out: LspLocation[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const item = entry as {
      uri?: unknown
      targetUri?: unknown
      range?: unknown
      targetSelectionRange?: unknown
      targetRange?: unknown
    }
    const uri = typeof item.uri === 'string' ? item.uri : typeof item.targetUri === 'string' ? item.targetUri : undefined
    if (uri === undefined) continue
    const range = isRange(item.targetSelectionRange)
      ? item.targetSelectionRange
      : isRange(item.range)
        ? item.range
        : isRange(item.targetRange)
          ? item.targetRange
          : undefined
    if (range === undefined) continue
    const path = pathOf(uri)
    if (path === undefined) continue
    out.push({ path, range: fromLspRange(range) })
  }
  return out
}

/** A hover's `contents` in any of the three protocol shapes, as text. */
export function hoverText(contents: unknown): string {
  if (contents === null || contents === undefined) return ''
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents
      .map(part => hoverText(part))
      .filter(part => part !== '')
      .join('\n\n')
  }
  if (typeof contents === 'object') {
    const marked = contents as { value?: unknown }
    if (typeof marked.value === 'string') return marked.value
  }
  return ''
}

/** A `documentSymbol` answer in either shape (`SymbolInformation[]` / `DocumentSymbol[]`). */
export function symbolsOf(raw: unknown): LspSymbol[] {
  if (!Array.isArray(raw)) return []
  const out: LspSymbol[] = []
  for (const entry of raw) {
    const symbol = symbolOf(entry)
    if (symbol !== undefined) out.push(symbol)
  }
  return out
}

function symbolOf(entry: unknown): LspSymbol | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const item = entry as {
    name?: unknown
    kind?: unknown
    range?: unknown
    location?: { range?: unknown }
    selectionRange?: unknown
    children?: unknown
  }
  if (typeof item.name !== 'string' || typeof item.kind !== 'number') return undefined
  // `DocumentSymbol` carries its ranges; `SymbolInformation` nests them under `location`.
  const range = isRange(item.range) ? item.range : isRange(item.location?.range) ? item.location.range : undefined
  if (range === undefined) return undefined
  const selection = isRange(item.selectionRange) ? item.selectionRange : range
  const symbol: LspSymbol = {
    name: item.name,
    kind: item.kind,
    range: fromLspRange(range),
    selectionRange: fromLspRange(selection),
  }
  const children = Array.isArray(item.children) ? item.children : undefined
  if (children !== undefined) {
    const nested = symbolsOf(children)
    if (nested.length > 0) symbol.children = nested
  }
  return symbol
}

/** The parts of a mount context this half uses (declared locally on purpose). */
interface MountFiberContext {
  provide?(name: string, value: unknown): unknown
  get?(name: string): unknown
}

export const lspHalf = {
  name: 'lsp',
  inject: ['diorama'],
  apply(ctx: { diorama: { mounts: Mounts } }) {
    ctx.diorama.mounts.onMount((mountCtx, info) => {
      const mount = mountCtx as unknown as MountFiberContext
      if (typeof mount.provide !== 'function') return undefined
      // `fs` is resolved when a query runs, not here: this callback runs while
      // the mount fiber is still applying, so `fs` is not provided yet (the same
      // shape as `SearchService`, contract.md §3.9).
      const service = new LspService(info.root, () => {
        const fs = mount.get?.('fs')
        if (fs === undefined) throw rpcError('ESERVICE', 'no "fs" on this mount; lsp is unavailable')
        return fs as FsService
      })
      mount.provide('lsp', service)
      return () => {
        void service.close()
      }
    })
    return undefined
  },
}
