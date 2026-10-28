/**
 * The mount's **raw bytes** route (contract.md §4): `<origin>/~raw~/<RelPath>`.
 *
 * Three reader actions point at this one URL — download, copy the link, open it
 * in a browser window — so the URL names the **resource** (the file itself),
 * not an action: `?download=1` is the action, and it only changes
 * `content-disposition`.
 *
 * Everything here is a pure function so `node --test` covers it without a
 * server: the encoding of the path, the URL itself, and the one header that has
 * to survive a non-ASCII file name.
 */
import { isTextualMime, mimeOf } from './mime.ts'
import { RAW_PREFIX, type RelPath } from './types.ts'

/** Whether a URL asks for the file to be saved rather than shown. */
export const DOWNLOAD_QUERY = 'download'

/**
 * Encode a mount-relative path for the route: every segment, `/` kept as the
 * separator (the same rule as `encodeRoute`, contract.md §3.8).
 */
export function encodeRawPath(path: RelPath): string {
  return path
    .split('/')
    .filter(segment => segment !== '')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

/**
 * Decode the part after {@link RAW_PREFIX}. `undefined` = this is not a raw
 * URL; `false` = the escape is malformed (the caller answers 400, never a
 * guess). Containment is **not** checked here: the server resolves the result
 * with `resolveInside`, which is the one place that decides what is inside the
 * mount (contract.md §3.1).
 */
export function decodeRawPath(urlPath: string): RelPath | undefined | false {
  if (!urlPath.startsWith(RAW_PREFIX)) return undefined
  const encoded = urlPath.slice(RAW_PREFIX.length)
  if (encoded === '') return false
  try {
    return decodeURIComponent(encoded)
  } catch {
    return false
  }
}

/**
 * The absolute URL of one file's bytes. `baseUrl` is the mount's origin
 * (`MountInfo.baseUrl`); a trailing slash is tolerated because that is how the
 * CLI prints it.
 */
export function rawUrl(baseUrl: string, path: RelPath, options: { download?: boolean } = {}): string {
  const base = baseUrl.replace(/\/+$/, '')
  const url = `${base}${RAW_PREFIX}${encodeRawPath(path)}`
  return options.download === true ? `${url}?${DOWNLOAD_QUERY}=1` : url
}

/**
 * The media type of a file's bytes: the kernel's own table, plus a **charset**
 * for the textual ones.
 *
 * `text/*` without a `charset` is *not* UTF-8 by definition — a browser falls
 * back to a locale guess (windows-1252 on most installs), so a file full of
 * Chinese came out as mojibake in a new window while the same file rendered
 * correctly inside diorama. `diorama` reads every text file as UTF-8
 * (`fs.readText`), so the bytes on this route are UTF-8 as well, and the header
 * has to say so. The renderer matcher keeps the bare type: `text/plain` is what
 * a matcher compares against (contract §5.1).
 */
export function rawContentType(path: RelPath): string {
  const type = mimeOf(path)
  return isTextualMime(type) ? `${type}; charset=utf-8` : type
}

/**
 * `content-disposition` for a save: an ASCII fallback for old clients plus the
 * RFC 5987 `filename*` for everyone else, so a Chinese file name survives the
 * "save as" dialog instead of becoming a row of underscores.
 *
 * Control characters are dropped and the fallback quotes are replaced: a file
 * name is input from the disk, and this header is a line of text on the wire.
 */
export function contentDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '')
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii === '' ? 'download' : ascii}"; filename*=UTF-8''${encodeRfc5987(clean)}`
}

/**
 * `encodeURIComponent` leaves `!'()*` alone, and RFC 5987's `attr-char` does
 * not include them — so they are escaped here rather than shipped as-is.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}
