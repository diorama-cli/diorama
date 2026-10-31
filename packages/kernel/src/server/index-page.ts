/**
 * The gateway's own index page (contract.md §7.7): every mounted directory with
 * its URL, at a fixed address from `[gateway] port` in `diorama.toml`.
 *
 * It is deliberately **not** a mount: a mount is a directory being browsed and
 * carries the whole page shell, the plugin graph and an RPC channel. This is one
 * server-rendered HTML document over the gateway's mount table — the bookmark
 * that survives a `gateway restart`, which the mount URLs do not
 * (architecture.md §10: mounts are not persisted).
 *
 * The rows are plain links with `target="_blank"`: the whole point is "click
 * it, the scene opens in a window of its own".
 */
import { createServer, type Server } from 'node:http'
import type { MountStatus } from '../shared/control.ts'

export interface IndexPageInfo {
  pid: number
  version: string
  contract: string
  startedAt: number
}

export interface IndexServerOptions {
  /** The mount table, read per request (mounts come and go). */
  list(): MountStatus[]
  /** Process identity, shown in the header. */
  info: IndexPageInfo
  /** The control socket path, shown in the footer (the CLI knows it, the kernel does not). */
  socket?: string
  log?: (message: string) => void
}

export interface IndexServer {
  server: Server
  close(): Promise<void>
}

/** HTML-escape a value that goes into text or an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** `2026-11-01 00:00` in the machine's own zone (the reader's clock is the truth here). */
export function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** How one mount reads on the page: the state, plus why when it is degraded. */
function stateLabel(mount: MountStatus): string {
  if (mount.state === 'degraded' && mount.lastError !== undefined) {
    return `degraded — ${mount.lastError.message}`
  }
  return mount.state
}

/** One mount as a card: the whole card is the link, so a click opens a window. */
function mountRow(mount: MountStatus): string {
  const name = mount.root.slice(mount.root.lastIndexOf('/') + 1) || mount.root
  const config = mount.configFile ?? 'defaults'
  const plugins = mount.plugins.length
  return [
    `    <li data-testid="gateway-index-mount" data-mount-id="${escapeHtml(mount.mountId)}" data-root="${escapeHtml(mount.root)}" data-url="${escapeHtml(mount.url)}">`,
    `      <a class="mount mount--${escapeHtml(mount.state)}" href="${escapeHtml(mount.url)}" target="_blank" rel="noopener">`,
    `        <span class="mount__name">${escapeHtml(name)}</span>`,
    `        <span class="mount__path">${escapeHtml(mount.root)}</span>`,
    `        <span class="mount__url">${escapeHtml(mount.url)}</span>`,
    `        <span class="mount__meta">${escapeHtml(stateLabel(mount))} · ${plugins} plugin${plugins === 1 ? '' : 's'} · config: ${escapeHtml(config)}</span>`,
    '      </a>',
    '    </li>',
  ].join('\n')
}

/**
 * The document. Pure: the whole page is a function of the mount table, so a
 * test can assert on it without a socket.
 */
export function renderIndexPage(mounts: readonly MountStatus[], options: { info: IndexPageInfo; socket?: string }): string {
  const { info } = options
  const count = mounts.length
  const body = count === 0
    ? '    <p class="empty" data-testid="gateway-index-empty">No mounts right now — run <code>diorama &lt;dir&gt;</code> to add one.</p>'
    : `    <ul class="mounts">\n${mounts.map(mountRow).join('\n')}\n    </ul>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>diorama gateway</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa;
    --fg: #1d1d1f;
    --muted: #6b6b70;
    --card: #ffffff;
    --line: #e3e3e0;
    --accent: #2f6feb;
    --warn: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a;
      --fg: #e8e8ea;
      --muted: #9a9aa2;
      --card: #1e1e23;
      --line: #2e2e35;
      --accent: #7aa2f7;
      --warn: #f0a05a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2.5rem 1.5rem 3rem;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main, header, footer { max-width: 62rem; margin: 0 auto; }
  h1 { margin: 0 0 .25rem; font-size: 1.25rem; letter-spacing: -.01em; }
  .meta { margin: 0; color: var(--muted); font-size: .8125rem; }
  .mounts { list-style: none; margin: 1.5rem 0 0; padding: 0; display: grid; gap: .625rem; }
  .mount {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "name url" "path path" "meta meta";
    gap: .125rem .75rem;
    padding: .75rem .875rem;
    border: 1px solid var(--line);
    border-radius: .5rem;
    background: var(--card);
    color: inherit;
    text-decoration: none;
  }
  .mount:hover, .mount:focus-visible { border-color: var(--accent); outline: none; }
  .mount:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
  .mount__name { grid-area: name; font-weight: 600; overflow-wrap: anywhere; }
  .mount__url { grid-area: url; color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; align-self: center; }
  .mount__path { grid-area: path; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .75rem; overflow-wrap: anywhere; }
  .mount__meta { grid-area: meta; color: var(--muted); font-size: .75rem; margin-top: .25rem; }
  .mount--degraded .mount__meta { color: var(--warn); }
  .empty { margin: 1.5rem 0 0; color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .75rem; }
  footer code { overflow-wrap: anywhere; }
</style>
</head>
<body data-testid="gateway-index">
  <header>
    <h1>diorama gateway</h1>
    <p class="meta">pid ${info.pid} · v${escapeHtml(info.version)} · contract ${escapeHtml(info.contract)} · ${count} mount${count === 1 ? '' : 's'} · started ${formatTime(info.startedAt)}</p>
  </header>
  <main>
${body}
  </main>
  <footer>
    Click a directory to open it in a new window.${options.socket === undefined ? '' : ` Control socket: <code>${escapeHtml(options.socket)}</code>.`}
  </footer>
</body>
</html>
`
}

/**
 * The index listener. Every request is a fresh render: the table changes as
 * mounts come and go, and a cached page would be a lie.
 */
export function createIndexServer(options: IndexServerOptions): IndexServer {
  const log = options.log ?? ((message: string) => console.error(message))
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://gateway.local')
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      const payload = JSON.stringify({ error: { code: 'ENOENT', message: `no route for ${url.pathname}` } })
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
      response.end(payload)
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' })
      response.end()
      return
    }
    let page: string
    try {
      page = renderIndexPage(options.list(), {
        info: options.info,
        ...(options.socket === undefined ? {} : { socket: options.socket }),
      })
    } catch (failure) {
      log(`index page: ${failure instanceof Error ? failure.message : String(failure)}`)
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('the mount table could not be read\n')
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(page),
      'cache-control': 'no-store',
    })
    response.end(request.method === 'HEAD' ? undefined : page)
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  return {
    server,
    async close() {
      server.closeAllConnections()
      server.closeIdleConnections()
      await new Promise<void>(done => server.close(() => done()))
    },
  }
}
