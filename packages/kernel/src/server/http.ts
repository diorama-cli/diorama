/**
 * Single-directory HTTP server: static shell, the plugin boot graph, client
 * halves of the selected plugins, and the RPC upgrade endpoint.
 *
 * Deliberately minimal (plan.md M1): one directory, one port, loopback by
 * default, no socket, no auth. Every request runs inside an error boundary so a
 * plugin bug becomes a 500 for that request instead of a process crash
 * (architecture.md §12, HTTP layer). File access is *not* an HTTP API any more:
 * the M0 `/api/fs/*` routes are gone in favour of RPC (contract.md §4).
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { isErrorCode } from '../shared/errors.ts'
import { contentDisposition, decodeRawPath, DOWNLOAD_QUERY, rawContentType } from '../shared/raw.ts'
import { ROUTE_PREFIX, type RelPath } from '../shared/types.ts'
import { HttpError } from './errors.ts'
import { resolveInside } from './fs.ts'
import type { BootManifest } from './plan.ts'
import { RpcChannel, type RpcDispatcher } from './rpc.ts'
import { withShellTitle } from './shell-title.ts'

export interface MountOptions {
  /** Absolute root directory. */
  root: string
  mountId: string
  /** Directory of built assets (`index.html` + `assets/`). */
  assetsRoot: string
  /** Plugin id → absolute path of the client-half bundle. */
  clientEntries: ReadonlyMap<string, string>
  /** Where RPC calls land (contract.md §4). */
  dispatcher: RpcDispatcher
  /** The boot graph served at `/plugin.json`. */
  manifest: BootManifest
  /** Console sink. */
  log?: (message: string) => void
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** Errors raised by services carry `code`; the HTTP layer answers with them. */
const ERROR_STATUS: Record<string, number> = {
  EINVAL: 400,
  EBADREQUEST: 400,
  ENOENT: 404,
  ENOTDIR: 400,
  EISDIR: 400,
  EOUTSIDE: 403,
  EBINARY: 415,
  ETOOLARGE: 413,
  EMETHOD: 404,
  ESERVICE: 503,
  EIO: 500,
}

/** Serve one file under `dir`; returns false when nothing matched. */
async function serveStatic(dir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    throw new HttpError(400, 'EBADPATH', 'malformed URL encoding')
  }
  const base = resolve(dir)
  const target = normalize(join(base, decoded))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new HttpError(403, 'EBADPATH', 'path escapes the asset root')
  }
  let info
  try {
    info = await stat(target)
  } catch {
    return false
  }
  if (!info.isFile()) return false
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    'content-length': info.size,
  })
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(target)
    stream.on('error', reject)
    stream.on('end', resolveStream)
    stream.pipe(res)
  })
  return true
}

/**
 * Answer `/~raw~/<path>` with the file's own bytes (contract.md §4).
 *
 * The media type is the kernel's table and nothing else: a `.png` is an image
 * the browser shows, a `.zip` is something it saves, a `.html` is a page it
 * renders. **`inline` is the default** — only `?download=1` sends
 * `content-disposition: attachment` — so the same URL is the link a reader
 * copies and the one a window opens.
 *
 * Containment is `resolveInside`'s, exactly as `ctx.fs` does it (contract.md
 * §3.1): absolute paths, `..` escapes and NUL are refused before the disk is
 * touched. `ignore` is not consulted: hiding a name from `list` never made it
 * unreadable by path, and the reader right-clicked a row they could see.
 *
 * There is no size limit here, unlike `fs.readBytes` (`MAX_BINARY_BYTES`): the
 * bytes stream to the browser, which has its own progress and its own disk.
 */
async function serveRaw(options: MountOptions, path: RelPath, download: boolean, head: boolean, res: ServerResponse): Promise<void> {
  const abs = resolveInside(options.root, path)
  let info
  try {
    info = await stat(abs)
  } catch (error) {
    // A missing file and a broken symlink are the same answer to the reader.
    if ((error as { code?: unknown }).code === 'ENOENT') throw new HttpError(404, 'ENOENT', `no such file: ${path}`)
    throw error
  }
  if (!info.isFile()) throw new HttpError(400, 'EISDIR', `not a file: ${path}`)
  const name = path.slice(path.lastIndexOf('/') + 1)
  const headers: Record<string, string> = {
    'content-type': rawContentType(path),
    'content-length': String(info.size),
    // The file is on disk and may change under the reader: revalidate, do not
    // cache blindly, and do not re-download a 200 MB video on every open.
    'cache-control': 'no-cache',
    etag: `"${info.mtimeMs.toString(36)}-${info.size.toString(36)}"`,
    // The bytes are the file, not something this page inferred: never let a
    // sniffing browser turn them into another type.
    'x-content-type-options': 'nosniff',
    ...(download ? { 'content-disposition': contentDisposition(name) } : {}),
  }
  res.writeHead(200, headers)
  if (head) {
    res.end()
    return
  }
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(abs)
    stream.on('error', reject)
    stream.on('end', resolveStream)
    stream.pipe(res)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

async function handleRequest(
  options: MountOptions,
  manifest: BootManifest,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'EBADREQUEST', `method ${req.method ?? '?'} not allowed`)
    return
  }
  // (HEAD is answered like GET with the body left out: every route below writes
  // through `res`, and Node drops the payload for a HEAD response itself.)
  const url = new URL(req.url ?? '/', 'http://mount.local')
  const pathname = url.pathname

  switch (pathname) {
    case '/plugin.json':
      sendJson(res, 200, manifest)
      return
    case '/__diorama__/page.js':
      // The page bridge must exist before the shell or any client half runs:
      // halves reach it through the global (docs/m0/spec.md §10.3).
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE_BRIDGE_SCRIPT)
      return
    case '/__diorama__/rpc':
      // WebSocket upgrades never reach here (the server handles them); a plain
      // GET means someone tried to use the endpoint as an HTTP API.
      sendError(res, 426, 'EBADREQUEST', 'the RPC endpoint only speaks WebSocket')
      return
    default:
      break
  }

  if (pathname.startsWith('/plugins/')) {
    const rest = pathname.slice('/plugins/'.length)
    // `/plugins/<id>/<path>` is a **file the plugin ships beside its client
    // half** (a vendored library's stylesheet and fonts, say). The half is a
    // self-contained closure, so a piece that needs a runtime asset too big to
    // bundle serves it from its own package instead of inlining it.
    const slash = rest.indexOf('/')
    if (slash !== -1) {
      const id = rest.slice(0, slash)
      const entry = options.clientEntries.get(id)
      if (entry === undefined) {
        sendError(res, 404, 'ENOENT', `plugin "${id}" is not in this mount's boot graph`)
        return
      }
      // `serveStatic` refuses a path that escapes the directory it is given.
      if (await serveStatic(dirname(entry), rest.slice(slash), res)) return
      sendError(res, 404, 'ENOENT', `plugin "${id}" ships no asset "${rest.slice(slash + 1)}"`)
      return
    }
    // `/plugins/<id>.js` is the public URL; the file on disk may be `.cjs`.
    const id = rest.replace(/\.js$/, '')
    const entry = options.clientEntries.get(id)
    if (entry === undefined) {
      sendError(res, 404, 'ENOENT', `plugin "${id}" is not in this mount's boot graph`)
      return
    }
    if (await serveStatic(dirname(entry), `/${basename(entry)}`, res)) return
    sendError(res, 404, 'ENOENT', `client entry of plugin "${id}" is missing`)
    return
  }

  // The mount's raw bytes (contract.md §4): `/~raw~/<path>` is the file itself,
  // not the page that shows it. It sits before the shell fallback below, which
  // would otherwise answer every unknown path with the page.
  const raw = decodeRawPath(pathname)
  if (raw === false) {
    throw new HttpError(400, 'EBADPATH', 'malformed URL encoding')
  }
  if (raw !== undefined) {
    await serveRaw(options, raw, url.searchParams.get(DOWNLOAD_QUERY) !== null, req.method === 'HEAD', res)
    return
  }

  if (pathname === '/' || pathname === '/index.html') {
    if (await serveShell(options, manifest, res)) return
  }
  if (await serveStatic(options.assetsRoot, pathname, res)) return
  // The page's own routes (contract.md §3.8): `/~/<path>` is never a file and
  // never an API call — it is the shell that reads the path. `/api/` stays an
  // API namespace (unknown routes there are 404s, not the page).
  if (pathname === ROUTE_PREFIX.slice(0, -1) || pathname.startsWith(ROUTE_PREFIX)) {
    if (await serveShell(options, manifest, res)) return
    sendError(res, 500, 'EIO', 'the page shell is missing (no index.html in the assets root)')
    return
  }
  // Unknown non-API paths fall back to the shell (SPA semantics).
  if (!pathname.startsWith('/api/') && (await serveShell(options, manifest, res))) return
  sendError(res, 404, 'ENOENT', `no route for ${pathname}`)
}

/**
 * Serve `index.html` with two things injected first:
 *
 * - the page's title, which is the served directory's name: the shell is static
 *   HTML and the root is only known here, so this is where the two meet
 *   (contract.md §34);
 * - the page-bridge bootstrap, which must exist before the shell's entry and
 *   before any half script runs;
 * - the mount's configured start theme (`[ui] theme`, contract.md §4.1), as
 *   `window.__diorama_theme__`. The shell's pre-paint block runs before any
 *   fetch and before the bundle, so the only way it can know a pinned start is
 *   for the server to put it there — this is the one place that has both the
 *   file and the configuration.
 *
 * A theme **id** is not injected: the shell cannot resolve which scheme it is
 * (the theme lives in a piece), so the page follows the OS for the first frame
 * and the service repaints once it boots. `light` / `dark` / `system` need no
 * registry, so they are answered before the first paint.
 */
async function serveShell(options: MountOptions, manifest: BootManifest, res: ServerResponse): Promise<boolean> {
  let html: string
  try {
    html = await readFile(join(options.assetsRoot, 'index.html'), 'utf8')
  } catch {
    return false
  }
  const start = manifest.config?.ui?.theme
  const theme = start === 'light' || start === 'dark' ? `<script>window.__diorama_theme__=${JSON.stringify(start)}</script>` : ''
  const tag = '<script src="/__diorama__/page.js"></script>'
  const head = [theme, tag].filter(part => part !== '').join('\n    ')
  const shell = withShellTitle(html, options.root)
  const body = shell.includes(tag) ? shell : shell.replace(/<head>/, match => `${match}\n    ${head}`)
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
  return true
}

export interface MountServer {
  server: Server
  channel: RpcChannel
  /** The boot graph `/plugin.json` serves (replaceable: the port is known after binding). */
  manifest: BootManifest
  /** Stop accepting, drop RPC peers, close. */
  close(): Promise<void>
}

/** Create the per-directory HTTP server with its RPC channel (not yet listening). */
export function createMountServer(options: MountOptions): MountServer {
  const log = options.log ?? (message => console.error(`[mount:${options.mountId}] ${message}`))
  const channel = new RpcChannel({ dispatcher: options.dispatcher, log })
  // `/plugin.json` carries the mount URL, which a random port only decides at
  // bind time (contract.md §7.3): the gateway replaces the manifest afterwards
  // and the running server answers with the replacement.
  const server = createServer((req, res) => {
    handleRequest(options, mountServer.manifest, req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message)
        return
      }
      const code = (error as { code?: unknown }).code
      if (isErrorCode(code)) {
        sendError(res, ERROR_STATUS[code] ?? 500, code, (error as Error).message)
        return
      }
      log(`request failed: ${req.method} ${req.url} ${error instanceof Error ? error.message : String(error)}`)
      sendError(res, 500, 'EIO', error instanceof Error ? error.message : String(error))
    })
  })
  server.on('upgrade', (request, socket, head) => {
    if (!channel.upgrade(request, socket, head)) socket.destroy()
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  const mountServer: MountServer = {
    server,
    channel,
    manifest: options.manifest,
    async close() {
      channel.close()
      // Drop every remaining socket hard (keep-alive HTTP and any upgrade the
      // channel did not own), so `close()` resolves instead of waiting them out.
      server.closeAllConnections()
      server.closeIdleConnections()
      await new Promise<void>(done => server.close(() => done()))
    },
  }
  return mountServer
}

/** Listen on an explicit port; `EADDRINUSE` is surfaced to the caller. */
export async function listen(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('diorama: server has no TCP address')
  }
  return address.port
}

/**
 * Boot script: the page bridge, installed before the shell or any half runs.
 *
 * The face is exactly `PageBridge` (packages/kernel/src/client/page.ts): methods
 * only, and every caller invokes them *through* the object — React may invoke a
 * subscribe reference detached, and a half's inlined copy of a state object is
 * not the shell's state object.
 */
const PAGE_BRIDGE_SCRIPT = `;(function () {
  if (globalThis.__diorama_page__) return
  var kernel, version = 0, listeners = new Set()
  var bridge = {
    getKernel: function () { return kernel },
    getVersion: function () { return version },
    subscribe: function (listener) {
      listeners.add(listener)
      return function () { listeners.delete(listener) }
    },
    install: function (value) {
      if (kernel !== undefined) throw new Error('diorama kernel: a page kernel is already installed')
      kernel = value
      bridge.notify()
    },
    notify: function () {
      version++
      var snapshot = []
      listeners.forEach(function (listener) { snapshot.push(listener) })
      for (var i = 0; i < snapshot.length; i++) snapshot[i]()
    },
  }
  Object.defineProperty(globalThis, '__diorama_page__', { value: bridge, configurable: true })
})()
`
