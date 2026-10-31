/**
 * Static file serving under one directory (the built shell's assets, a
 * plugin's vendored files, the gateway index page). Split out of `http.ts`
 * so the gateway's own listener can serve files without building a whole
 * per-directory mount (contract.md §7.7).
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'
import { HttpError } from './errors.ts'

/** Media types the shell and its plugins ship; anything else is bytes. */
export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

/**
 * Serve one file under `dir`; returns false when nothing matched.
 *
 * Containment is the same rule as everywhere else: a path that resolves
 * outside `dir` is refused before the disk is touched.
 */
export async function serveStatic(dir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
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
