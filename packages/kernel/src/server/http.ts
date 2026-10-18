/**
 * Single-directory HTTP server: static shell, the plugin boot graph, client
 * halves of the selected plugins, and the M0 fs transport.
 *
 * Deliberately minimal (plan.md M0): one directory, one port, loopback by
 * default, no socket, no auth. Every request runs inside an error boundary so a
 * plugin bug becomes a 500 for that request instead of a process crash
 * (architecture.md §12, HTTP layer).
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { FS_HTTP_STATUS, type FsErrorCode } from '../shared/errors.ts'
import { HttpError } from './errors.ts'
import { FsService } from './fs.ts'
import type { BootManifest } from './plan.ts'

export interface MountOptions {
  /** Absolute root directory. */
  root: string
  mountId: string
  /** Directory of built assets (`index.html` + `assets/`). */
  assetsRoot: string
  /** Plugin id → absolute path of the client-half bundle. */
  clientEntries: ReadonlyMap<string, string>
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

function isFsCode(code: unknown): code is FsErrorCode {
  return typeof code === 'string' && code in FS_HTTP_STATUS
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

/** Read a required query parameter; a missing one is a malformed request. */
function queryParam(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (value === null) throw new HttpError(400, 'EBADREQUEST', `missing query parameter "${name}"`)
  return value
}

async function handleRequest(
  options: MountOptions,
  fs: FsService,
  manifest: BootManifest,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'EBADREQUEST', `method ${req.method ?? '?'} not allowed`)
    return
  }
  const url = new URL(req.url ?? '/', 'http://mount.local')
  const pathname = url.pathname

  switch (pathname) {
    case '/api/fs/list':
      sendJson(res, 200, { entries: await fs.list(queryParam(url, 'path')) })
      return
    case '/api/fs/read': {
      const path = queryParam(url, 'path')
      try {
        const text = await fs.readText(path)
        sendJson(res, 200, { path, encoding: 'utf-8', text })
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (isFsCode(code)) {
          sendError(res, FS_HTTP_STATUS[code], code, (error as Error).message)
          return
        }
        throw error
      }
      return
    }
    case '/plugin.json':
      sendJson(res, 200, manifest)
      return
    case '/__diorama__/page.js':
      // The page bridge must exist before the shell or any client half runs:
      // halves reach it through the global (docs/m0/spec.md §10.3).
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE_BRIDGE_SCRIPT)
      return
    default:
      break
  }

  if (pathname.startsWith('/plugins/')) {
    // `/plugins/<id>.js` is the public URL; the file on disk may be `.cjs`.
    const id = pathname.slice('/plugins/'.length).replace(/\.js$/, '')
    const entry = options.clientEntries.get(id)
    if (entry === undefined) {
      sendError(res, 404, 'ENOENT', `plugin "${id}" is not in this mount's boot graph`)
      return
    }
    if (await serveStatic(dirname(entry), `/${basename(entry)}`, res)) return
    sendError(res, 404, 'ENOENT', `client entry of plugin "${id}" is missing`)
    return
  }

  if (pathname === '/' || pathname === '/index.html') {
    if (await serveShell(options.assetsRoot, res)) return
  }
  if (await serveStatic(options.assetsRoot, pathname, res)) return
  // Unknown non-API paths fall back to the shell (SPA semantics).
  if (!pathname.startsWith('/api/') && (await serveShell(options.assetsRoot, res))) return
  sendError(res, 404, 'ENOENT', `no route for ${pathname}`)
}

/**
 * Serve `index.html` with the page-bridge bootstrap injected first: the bridge
 * must exist before the shell's entry and before any half script runs.
 */
async function serveShell(assetsRoot: string, res: ServerResponse): Promise<boolean> {
  let html: string
  try {
    html = await readFile(join(assetsRoot, 'index.html'), 'utf8')
  } catch {
    return false
  }
  const tag = '<script src="/__diorama__/page.js"></script>'
  const body = html.includes(tag) ? html : html.replace(/<head>/, match => `${match}\n    ${tag}`)
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
  return true
}

/** Create the per-directory HTTP server (not yet listening). */
export function createMountServer(options: MountOptions, manifest: BootManifest): Server {
  const fs = new FsService(options.root)
  const server = createServer((req, res) => {
    handleRequest(options, fs, manifest, req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message)
        return
      }
      const code = (error as { code?: unknown }).code
      if (isFsCode(code)) {
        sendError(res, FS_HTTP_STATUS[code], code, (error as Error).message)
        return
      }
      console.error(`[mount:${options.mountId}] request failed: ${req.method} ${req.url}`, error)
      sendError(res, 500, 'EIO', error instanceof Error ? error.message : String(error))
    })
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  return server
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
