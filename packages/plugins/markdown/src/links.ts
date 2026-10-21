/**
 * Where a link inside a rendered Markdown file points (docs/m12/spec.md).
 *
 * A repository's Markdown links are written **relative to the file** they live
 * in (`docs/notes.md`, `../README.md`, `#section`), while the page's own URL is
 * a route (`/~/<RelPath>`, contract.md §3.8). Letting the browser follow one
 * navigates the whole page, which drops every open tab — the tab set is not in
 * the URL (only the active file is). The renderer therefore classifies each
 * link before the click reaches the browser:
 *
 * - `file`     — a path inside the mount: open it in a tab, in the page;
 * - `anchor`   — a heading in **this** file: scroll to it;
 * - `external` — another origin or a scheme (`https:`, `mailto:`): leave this
 *                page alone (the renderer opens it in a new browser tab);
 * - `invalid`  — nothing sensible to open (an escape above the mount root, a
 *                malformed escape, an empty href): the click is swallowed.
 *
 * Pure on purpose: `node --test` cannot load `.tsx`, and the classification is
 * the part worth testing (the DOM side is one `scrollIntoView`).
 */

/** What a link resolves to, relative to the file that contains it. */
export type LinkTarget =
  | { kind: 'external' }
  | { kind: 'anchor'; id: string }
  | { kind: 'file'; path: string; anchor?: string }
  | { kind: 'invalid' }

/** Any `scheme:` prefix (`https:`, `mailto:`, `data:` …). */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** Decode one URL escape sequence; `undefined` when it is malformed. */
function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/** The directory part of a mount path (`''` for a top-level file). */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/**
 * Resolve a link path against the file it appears in.
 *
 * `undefined` = the path leaves the mount root (or names the root itself):
 * both are refused rather than opened, so a `../../etc/passwd` link cannot
 * make the page ask for something outside the directory the server mounted.
 */
export function resolveLinkPath(filePath: string, link: string): string | undefined {
  // A leading `/` is the mount root (a repository's own absolute links).
  const segments: string[] = link.startsWith('/') ? [] : directoryOf(filePath).split('/').filter(segment => segment !== '')
  for (const segment of link.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

/**
 * Classify one `href` from a Markdown file at `filePath`.
 *
 * The fragment (`#section`) is kept apart: it names a heading **in the target
 * file**, not a file of its own. A query string is dropped: a mounted file is
 * read by path, so `?raw` / `?plain=1` would only make the path wrong.
 */
export function classifyLink(href: string, filePath: string): LinkTarget {
  const raw = href.trim()
  if (raw === '') return { kind: 'invalid' }
  // A bare fragment: this document.
  if (raw.startsWith('#')) {
    const id = decode(raw.slice(1))
    return id === undefined || id === '' ? { kind: 'invalid' } : { kind: 'anchor', id }
  }
  // `//host/path` is protocol-relative: another origin, not a path.
  if (raw.startsWith('//')) return { kind: 'external' }
  if (SCHEME.test(raw)) return { kind: 'external' }
  const hashAt = raw.indexOf('#')
  const beforeHash = hashAt === -1 ? raw : raw.slice(0, hashAt)
  const hash = hashAt === -1 ? undefined : raw.slice(hashAt + 1)
  const queryAt = beforeHash.indexOf('?')
  const pathPart = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt)
  if (pathPart === '') return { kind: 'invalid' }
  const decoded = decode(pathPart)
  if (decoded === undefined) return { kind: 'invalid' }
  const path = resolveLinkPath(filePath, decoded)
  if (path === undefined) return { kind: 'invalid' }
  if (hash === undefined) return { kind: 'file', path }
  const anchor = decode(hash)
  return anchor === undefined || anchor === '' ? { kind: 'file', path } : { kind: 'file', path, anchor }
}

/**
 * A heading's text as an `id`: lower-case, punctuation dropped, runs of
 * whitespace joined by `-` (the convention GitHub uses, so links written for
 * GitHub land here too). CJK text is kept as written — it has no case and no
 * word separators to lose.
 *
 * The input may be the heading's **inline HTML** (`Hello <em>World</em>`); tags
 * are stripped and the few entities the parser emits are turned back into the
 * characters they stand for.
 */
export function headingSlug(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_match, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * One document's heading ids, kept unique: `intro`, `intro-1`, `intro-2` …
 * (two headings may read the same; an anchor link still has to find one).
 */
export function uniqueHeadingId(base: string, seen: Map<string, number>): string {
  const slug = base === '' ? 'section' : base
  const count = seen.get(slug) ?? 0
  seen.set(slug, count + 1)
  return count === 0 ? slug : `${slug}-${count}`
}
