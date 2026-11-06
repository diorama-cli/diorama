/**
 * `ctx.search` server half: search a mounted directory **by name** or **by
 * content** (contract.md §3.9). Like `ctx.fs` it is a service plugin
 * (contract.md §2.5): `apply` runs once on the root context and registers one
 * `SearchService` per mount through `ctx.diorama.mounts`.
 *
 * It reads through `ctx.fs`, never through `node:fs` itself: the mount's
 * `ignore` rules, its path validation and its "nothing outside the root" rule
 * are then the same for search as for the tree (contract.md §3.1 — `list` is
 * the one enforcement point of hiding, and a search that found hidden files
 * would be a second one).
 *
 * Performance (v0.26) is about **doing less per file**, not about doing the same
 * thing in parallel:
 *
 * - a file's decoded text is **kept** between searches and revalidated with
 *   `stat` (mtime + ctime + size). A second query over the same directory then
 *   reads nothing at all — the read syscalls were always the cost, not the
 *   matching;
 * - a literal query starts with one case-insensitive pass over the raw text (a
 *   file without the needle is never lowercased or split), then `indexOf` on the
 *   folded text, and only the lines of a file that contains it are ever split;
 * - names that are binary by construction are not opened at all;
 * - the walk asks `fs.list` once per directory (the walk itself is a couple of
 *   milliseconds; it stays on `fs.list` because that is where `ignore` is
 *   enforced, contract.md §3.1).
 *
 * A content search still reads the files with a small worker pool: one
 * `Promise.all` over a whole tree would open as many descriptors as there are
 * files.
 */
import { readFile, stat } from 'node:fs/promises'
import { fsError, rpcError } from '../shared/errors.ts'
import { MAX_TEXT_BYTES } from '../shared/limits.ts'
import {
  clipLine,
  contentMatcher,
  fuzzyMatch,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES_PER_FILE,
  SEARCH_MAX_PATHS,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MAX_SCANNED_FILES,
  type SearchFile,
  type SearchKind,
  type SearchMatch,
  type SearchOptions,
  type SearchResult,
} from '../shared/search.ts'
import type { MethodDescriptor } from '../shared/rpc.ts'
import type { RelPath } from '../shared/types.ts'
import { FsService, resolveInside } from './fs.ts'
import type { Mounts } from './plugins.ts'
import { defaultRgPath, rgCandidates, RgUnavailable } from './ripgrep.ts'

declare module 'cordis' {
  interface Context {
    /** Read-only search over the mounted directory. Present on mount contexts only. */
    search: SearchService
  }
}

/** Files read at once by a content search (descriptors stay bounded). */
const CONCURRENCY = 16

/** File bytes a mount keeps decoded between searches (contract.md §3.9). */
export const SEARCH_CACHE_MAX_BYTES = 32 * 1024 * 1024

/** Files a mount keeps decoded between searches (contract.md §3.9). */
export const SEARCH_CACHE_MAX_FILES = 20_000

/**
 * Names a content search does not open at all (contract.md §3.9): every one of
 * them is binary by construction, so the NUL test would only be reached after
 * paying for the read. A text file with one of these extensions is therefore
 * not searchable by content — the same trade ripgrep makes.
 */
const BINARY_EXTENSIONS = new Set([
  '7z', 'a', 'ai', 'avi', 'bin', 'bmp', 'bz2', 'class', 'dat', 'dll', 'dmg', 'doc', 'docx', 'dylib',
  'eot', 'exe', 'flac', 'gif', 'gz', 'ico', 'jar', 'jpeg', 'jpg', 'm4a', 'mkv', 'mov', 'mp3', 'mp4',
  'node', 'o', 'obj', 'ogg', 'otf', 'pdf', 'png', 'psd', 'pyc', 'rar', 'so', 'tar', 'ttf', 'wasm',
  'wav', 'webm', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'xz', 'zip',
])

/** Whether a path's extension names a binary format. */
function isBinaryName(path: RelPath): boolean {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  if (dot <= slash) return false
  return BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/** One queued path of a walk: the file itself and its directory. */
interface WalkEntry {
  path: RelPath
  kind: 'file' | 'dir'
}

/** One file's decoded text, as the cache keeps it. */
interface CachedText {
  /** mtime of the file when it was read (ms since epoch). */
  mtimeMs: number
  /** ctime of the file when it was read: catches a same-size rewrite. */
  ctimeMs: number
  /** Size in bytes when it was read. */
  size: number
  /** The file, decoded as UTF-8. */
  text: string
}

/**
 * The decoded texts of one mount, least recently used first.
 *
 * A search is dominated by the read + decode of every file in the tree (one
 * `open`, one `read` and one decode per file); the matching itself is a few
 * milliseconds. Keeping the text turns the second query from "read the tree"
 * into "stat the tree", which is an order of magnitude cheaper. Every use is
 * validated against the file's own `stat`, so an edited file is re-read and never
 * served stale.
 */
class TextCache {
  private readonly entries = new Map<string, CachedText>()
  private bytes = 0

  get(path: RelPath): CachedText | undefined {
    const hit = this.entries.get(path)
    if (hit === undefined) return undefined
    // Re-insert: a `Map` iterates in insertion order, so the first key is the
    // least recently used one.
    this.entries.delete(path)
    this.entries.set(path, hit)
    return hit
  }

  set(path: RelPath, entry: CachedText): void {
    const old = this.entries.get(path)
    if (old !== undefined) {
      this.bytes -= old.size
      this.entries.delete(path)
    }
    this.entries.set(path, entry)
    this.bytes += entry.size
    while (this.bytes > SEARCH_CACHE_MAX_BYTES || this.entries.size > SEARCH_CACHE_MAX_FILES) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      const evicted = this.entries.get(oldest.value)
      this.entries.delete(oldest.value)
      if (evicted !== undefined) this.bytes -= evicted.size
    }
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  /** Files held right now (diagnostics/tests). */
  get size(): number {
    return this.entries.size
  }
}

/** One query, prepared once and applied to every file. */
interface Scan {
  /** The general matcher: line by line, for regex / whole word / the fallback. */
  matcher: { test(line: string): { column: number; length: number }[] }
  /** A plain literal can skip the regex engine entirely. */
  literal: boolean
  /** The literal to look for, already case-folded when the search is insensitive. */
  needle: string
  caseSensitive: boolean
  /**
   * The same literal as a whole-text test (no `g` flag). A file that does not
   * contain it is answered without being lowercased or split into lines, which
   * is what makes the common "no hit here" file cheap.
   */
  prefilter: RegExp
}

const METHODS: MethodDescriptor[] = [
  { name: 'search', arity: 2 },
  { name: 'paths', arity: 1 },
]

/**
 * Read-only search rooted at one mounted directory (contract.md §3.9).
 * Instances are created per mount, like `FsService`.
 */
export class SearchService {
  /** The mount's file service: the only door to disk. */
  private readonly resolveFs: () => FsService

  /** Decoded texts kept between searches (validated by `stat`). */
  private readonly cache = new TextCache()

  /**
   * `fs` is resolved **on first use**, not at construction: a mount's services
   * land when its fiber activates (a `provide` is an effect), and this service
   * is registered from `onMount` — before that. By the time a page searches,
   * the mount is up. A function also keeps the service independent of which
   * context object the lookup goes through.
   */
  /**
   * Where the optional ripgrep binary is (`undefined` = use the JavaScript
   * scanner). A function, so a page can decide late — and so a test can turn
   * the engine off.
   */
  private readonly resolveRg: () => string | undefined

  constructor(fs: FsService | (() => FsService), rg: () => string | undefined = defaultRgPath) {
    this.resolveFs = typeof fs === 'function' ? fs : () => fs
    this.resolveRg = rg
  }

  /** The mount's `fs`, resolved now (throws if the mount is being torn down). */
  private get fs(): FsService {
    return this.resolveFs()
  }

  /** The methods the RPC channel may proxy (contract.md §4). */
  describe(): MethodDescriptor[] {
    return METHODS
  }

  /** Drop every cached text (the mount is going away). */
  close(): void {
    this.cache.clear()
  }

  /** Files held in the text cache (diagnostics/tests). */
  get cachedFiles(): number {
    return this.cache.size
  }

  /**
   * Whether the decoded-text cache already holds the whole subtree.
   *
   * It decides between the two engines, not between right and wrong: both
   * produce the same result, so the only question is which is cheaper for this
   * particular call. A cold tree is dominated by reads, which is exactly what
   * the engine removes; a warm tree is dominated by the spawn, which the
   * JavaScript scanner does not pay.
   *
   * The denominator is the candidate count of the previous content search on
   * this mount — the only honest "how many files are there" the service knows
   * without walking again.
   */
  private cacheCovers(): boolean {
    if (this.cachedCandidates === 0) return false
    return this.cache.size >= this.cachedCandidates
  }

  /** Candidate files of the previous content search (see {@link cacheCovers}). */
  private cachedCandidates = 0

  /**
   * Search the mount. `options.kind` is `'name'` (the default: paths only) or
   * `'content'` (text inside files).
   *
   * An empty query returns nothing — a search is never a directory listing —
   * and a query longer than `SEARCH_MAX_QUERY_CHARS` is `EINVAL`.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    if (typeof query !== 'string') throw fsError('EINVAL', 'the query must be a string')
    if (query.length > SEARCH_MAX_QUERY_CHARS) {
      throw fsError('EINVAL', 'the query is longer than ' + SEARCH_MAX_QUERY_CHARS + ' characters')
    }
    const kind: SearchKind = options.kind === 'content' ? 'content' : 'name'
    const empty: SearchResult = { kind, files: [], totalFiles: 0, totalMatches: 0, truncated: false }
    if (query === '') return empty
    const maxFiles = bound(options.maxFiles, SEARCH_MAX_FILES)
    const maxMatchesPerFile = bound(options.maxMatchesPerFile, SEARCH_MAX_MATCHES_PER_FILE)
    const scope = options.scope ?? ''
    // Validate the scope before walking: a bad path must fail like `fs.list` does.
    if (scope !== '') await this.fs.stat(scope)
    return kind === 'name'
      ? await this.searchNames(query, scope, maxFiles)
      : await this.searchContents(query, { ...options, scope, maxFiles, maxMatchesPerFile })
  }

  /**
   * Every file path under `scope`, for the quick-open list (contract.md §3.9).
   *
   * Quick open needs *all* paths and no query; asking for them in one call is
   * one round trip instead of one per directory, and the walk is the one a
   * search uses (so `ignore` hides the same entries).
   */
  async paths(scope: RelPath = ''): Promise<RelPath[]> {
    if (typeof scope !== 'string') throw fsError('EINVAL', 'the scope must be a string')
    if (scope !== '') await this.fs.stat(scope)
    const out: RelPath[] = []
    await this.walk(scope, entry => {
      if (entry.kind !== 'file') return true
      out.push(entry.path)
      return out.length < SEARCH_MAX_PATHS
    })
    return out
  }

  /** Every path under `scope` whose name matches `query` as a subsequence. */
  private async searchNames(query: string, scope: RelPath, maxFiles: number): Promise<SearchResult> {
    const hits: { path: RelPath; score: number }[] = []
    let scanned = 0
    let truncated = false
    await this.walk(scope, entry => {
      if (entry.kind !== 'file') return true
      scanned++
      // The subsequence test runs on the whole path so `docs/app` finds
      // `docs/app.ts`; the score then rewards matches in the basename.
      const match = fuzzyMatch(entry.path, query)
      if (match !== undefined) hits.push({ path: entry.path, score: match.score })
      if (scanned >= SEARCH_MAX_SCANNED_FILES) {
        truncated = true
        return false
      }
      return true
    })
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    const files = hits.slice(0, maxFiles).map(hit => ({ path: hit.path, matches: [], count: 1 }))
    return {
      kind: 'name',
      files,
      totalFiles: hits.length,
      totalMatches: hits.length,
      truncated: truncated || hits.length > maxFiles,
    }
  }

  /** Every line of every text file under `scope` that matches `query`. */
  private async searchContents(
    query: string,
    options: SearchOptions & { scope: RelPath; maxFiles: number; maxMatchesPerFile: number },
  ): Promise<SearchResult> {
    const binary = this.resolveRg()
    // The engine is only worth a process when it can save reads. Once the
    // decoded-text cache covers most of the tree, the JavaScript scanner is
    // already cheaper than paying for a spawn (measured: a warm query is
    // ~135 ms here, while `rg -l` alone costs ~25 ms on top of it).
    if (binary !== undefined && !this.cacheCovers()) {
      const accelerated = await this.searchContentsWithRg(binary, query, options)
      if (accelerated !== undefined) return accelerated
    }
    return this.searchContentsInJs(query, options)
  }

  /**
   * The ripgrep path (contract.md §3.9): the same candidates `fs.list` would
   * produce, handed to the engine as an explicit list. Any problem — no
   * binary, a pattern the engine refuses, a crash — answers `undefined` and
   * the JavaScript scanner takes over, so the contract never depends on the
   * optional engine being there.
   */
  private async searchContentsWithRg(
    binary: string,
    query: string,
    options: SearchOptions & { scope: RelPath; maxFiles: number; maxMatchesPerFile: number },
  ): Promise<SearchResult | undefined> {
    const regex = options.regex === true
    const wholeWord = options.wholeWord === true
    const caseSensitive = options.caseSensitive === true
    // Validate here, not in the engine: an invalid pattern is `EINVAL`
    // (contract.md §3.9), and the engine answers "no match" for one it cannot
    // compile. The JavaScript engine is the contract's definition, so it
    // decides validity even on the path where it does not do the matching.
    if (regex && contentMatcher({ query, regex: true }) === undefined) {
      throw fsError('EINVAL', 'the query is not a valid regular expression')
    }
    // The pattern handed to the engine. Its dialect is close to JavaScript's but
    // not identical (a Unicode-aware `\b`, no `\p{…}` names JavaScript accepts),
    // which is harmless here **because the engine only narrows**: it may name a
    // file that turns out not to match, and the JavaScript scanner then finds
    // nothing in it. What it must never do is drop a file that does match, and
    // that is what the equivalence test pins down.
    const pattern = regex
      ? query
      : wholeWord
        ? `\\b(?:${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`
        : query
    const candidates: RelPath[] = []
    let truncated = false
    await this.walk(options.scope, entry => {
      if (entry.kind !== 'file') return true
      if (candidates.length >= SEARCH_MAX_SCANNED_FILES) {
        truncated = true
        return false
      }
      if (isBinaryName(entry.path)) return true
      candidates.push(entry.path)
      return true
    })
    // The engine only answers "which of these files contain the query". The
    // lines, columns and previews still come from the JavaScript scanner: the
    // answer is then identical by construction, and the engine's per-hit JSON
    // (which grows with the number of hits, not files) is never parsed.
    let narrowed: RelPath[]
    try {
      narrowed = await rgCandidates(
        binary,
        this.fs.root,
        // A whole-word literal is a regular expression to the engine (the
        // `\\b` wrapper), and so is a real one; a plain literal is not.
        { pattern, caseSensitive, regex: regex || wholeWord, wholeWord },
        candidates,
      )
    } catch (error) {
      if (error instanceof RgUnavailable) return undefined
      throw error
    }
    if (narrowed.length === 0) return { kind: 'content', files: [], totalFiles: 0, totalMatches: 0, truncated }
    // Back into **walk order**: the engine answers in its own order, and which
    // files survive `maxFiles` must not depend on which engine ran.
    const keep = new Set(narrowed)
    const ordered = candidates.filter(path => keep.has(path))
    this.cachedCandidates = candidates.length
    // A query that matches most of the tree is not what the engine is for: the
    // spawn and the list it returns cost more than the reads it saved. Hand
    // back to the JavaScript scanner, which now has the reads cached.
    if (ordered.length > candidates.length / 2) return undefined
    const matcher = contentMatcher({
      query,
      ...(caseSensitive ? { caseSensitive: true } : {}),
      ...(wholeWord ? { wholeWord: true } : {}),
      ...(regex ? { regex: true } : {}),
    })
    if (matcher === undefined) throw fsError('EINVAL', 'the query is not a valid regular expression')
    const scan: Scan = {
      matcher,
      literal: !wholeWord && !regex,
      needle: caseSensitive ? query : query.toLowerCase(),
      caseSensitive,
      prefilter: new RegExp(
        (caseSensitive ? query : query.toLowerCase()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        caseSensitive ? '' : 'i',
      ),
    }
    const scanned = await mapPool(ordered, CONCURRENCY, path =>
      this.scanFile(path, scan, options.maxMatchesPerFile),
    )
    const files: SearchFile[] = []
    let totalFiles = 0
    let totalMatches = 0
    for (const file of scanned) {
      if (file === undefined) continue
      totalFiles++
      totalMatches += file.count
      if (files.length < options.maxFiles) files.push(file)
      else truncated = true
    }
    return { kind: 'content', files, totalFiles, totalMatches, truncated }
  }

  /** The JavaScript scanner: the definition of "match", and the fallback. */
  private async searchContentsInJs(
    query: string,
    options: SearchOptions & { scope: RelPath; maxFiles: number; maxMatchesPerFile: number },
  ): Promise<SearchResult> {
    const matcher = contentMatcher({
      query,
      ...(options.caseSensitive === true ? { caseSensitive: true } : {}),
      ...(options.wholeWord === true ? { wholeWord: true } : {}),
      ...(options.regex === true ? { regex: true } : {}),
    })
    if (matcher === undefined) throw fsError('EINVAL', 'the query is not a valid regular expression')
    const caseSensitive = options.caseSensitive === true
    const literal = options.regex !== true && options.wholeWord !== true
    const needle = caseSensitive ? query : query.toLowerCase()
    const scan: Scan = {
      matcher,
      // Whole word and regex need the engine; a plain literal does not.
      literal,
      needle,
      caseSensitive,
      // One pass over the file, case-insensitive unless asked otherwise: the
      // cheap "this file cannot match" test that every literal search starts
      // with (a file that fails it is never lowercased or split).
      prefilter: new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i'),
    }
    // 1. Collect the candidates (bounded), 2. read them with a small pool, so a
    // directory of thousands of files never opens thousands of descriptors.
    const candidates: RelPath[] = []
    let truncated = false
    await this.walk(options.scope, entry => {
      if (entry.kind !== 'file') return true
      if (candidates.length >= SEARCH_MAX_SCANNED_FILES) {
        truncated = true
        return false
      }
      // A binary name is not a candidate: the read is the expensive part, and
      // the NUL test would only be reached after it (contract.md §3.9).
      if (isBinaryName(entry.path)) return true
      candidates.push(entry.path)
      return true
    })
    this.cachedCandidates = candidates.length
    const scanned = await mapPool(candidates, CONCURRENCY, path =>
      this.scanFile(path, scan, options.maxMatchesPerFile),
    )
    const files: SearchFile[] = []
    let totalFiles = 0
    let totalMatches = 0
    for (const file of scanned) {
      if (file === undefined) continue
      totalFiles++
      totalMatches += file.count
      if (files.length < options.maxFiles) files.push(file)
      else truncated = true
    }
    return { kind: 'content', files, totalFiles, totalMatches, truncated }
  }

  /** One file's matching lines; `undefined` for binary, missing or unreadable files. */
  private async scanFile(path: RelPath, scan: Scan, maxMatchesPerFile: number): Promise<SearchFile | undefined> {
    const abs = resolveInside(this.fs.root, path)
    const cached = this.cache.get(path)
    let text: string | undefined
    if (cached !== undefined) {
      // A hit is still validated: the file may have been written since the last
      // query, and serving the old text would answer about a file that is gone.
      let info
      try {
        info = await stat(abs)
      } catch {
        return undefined // vanished between listing and reading
      }
      if (!info.isFile() || info.size > MAX_TEXT_BYTES) return undefined
      if (info.mtimeMs === cached.mtimeMs && info.ctimeMs === cached.ctimeMs && info.size === cached.size) {
        text = cached.text
      }
    }
    if (text === undefined) {
      // The cold path reads and decodes, and the file's own size is the guard:
      // no `stat` first, so a first search pays one syscall per file and not two.
      let bytes: Uint8Array
      try {
        bytes = await readFile(abs)
      } catch {
        return undefined
      }
      if (bytes.length > MAX_TEXT_BYTES) return undefined
      if (bytes.includes(0)) return undefined // binary: no lines to search
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      let info
      try {
        info = await stat(abs)
      } catch {
        return undefined
      }
      this.cache.set(path, { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, text })
    }
    if (scan.literal) {
      const hit = scanLiteral(path, text, scan, maxMatchesPerFile)
      if (hit !== undefined) return hit.count === 0 ? undefined : { path, matches: hit.matches, count: hit.count }
      // The folding changed the text's length: only the engine can report the
      // columns of the original line (see `scanLiteral`).
    }
    return scanLines(path, text, scan.matcher, maxMatchesPerFile)
  }

  /**
   * Walk the mount breadth-first from `scope`, calling `visit` for every entry
   * (files and directories). A `false` return stops the walk.
   */
  private async walk(scope: RelPath, visit: (entry: WalkEntry) => boolean | Promise<boolean>): Promise<void> {
    const queue: RelPath[] = [scope]
    while (queue.length > 0) {
      const directory = queue.shift() as RelPath
      let entries
      try {
        entries = await this.fs.list(directory)
      } catch {
        continue // a directory removed mid-walk is not an error
      }
      // Files before directories: the common case (a hit near the root) is
      // found before the walk spends time in deep subtrees.
      for (const entry of [...entries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'file' ? -1 : 1))) {
        const next = await visit({ path: entry.path, kind: entry.kind })
        if (next === false) return
        if (entry.kind === 'dir') queue.push(entry.path)
      }
    }
  }
}

/**
 * The literal fast path: `indexOf` over the decoded (and, when the search is
 * case-insensitive, lowercased) text.
 *
 * Returns `undefined` only when case folding changed the text's length (a lone
 * `İ` lowercases to two code points): the columns would then no longer index
 * the original line, and the caller falls back to the regular expression, which
 * reports them correctly.
 */
function scanLiteral(
  path: RelPath,
  text: string,
  scan: Scan,
  maxMatchesPerFile: number,
): { matches: SearchMatch[]; count: number } | undefined {
  // The prefilter runs on the raw text: a file without the needle (the common
  // case) is never lowercased and never split.
  if (!scan.prefilter.test(text)) return { matches: [], count: 0 }
  const haystack = scan.caseSensitive ? text : text.toLowerCase()
  // A folding that changes the length (a lone `İ`) would make the columns
  // point at the wrong character: that file goes through the engine instead.
  if (haystack.length !== text.length) return undefined
  if (!haystack.includes(scan.needle)) return { matches: [], count: 0 }
  // Only a file that contains the needle pays for splitting it into lines.
  const lines = text.split('\n')
  const hayLines = haystack === text ? lines : haystack.split('\n')
  const matches: SearchMatch[] = []
  let count = 0
  for (let index = 0; index < hayLines.length; index++) {
    const hay = hayLines[index] ?? ''
    const first = hay.indexOf(scan.needle)
    if (first === -1) continue
    count += literalCount(hay, scan.needle)
    // Every hit counts towards `count`; only the first few are kept.
    if (matches.length < maxMatchesPerFile) {
      matches.push({
        path,
        line: index + 1,
        column: first + 1,
        length: scan.needle.length,
        text: clipLine(lines[index] ?? '', first + 1, scan.needle.length),
      })
    }
  }
  return { matches, count }
}

/** The general path: the regex engine (whole word, a real regex, or the folding fallback). */
function scanLines(
  path: RelPath,
  text: string,
  matcher: { test(line: string): { column: number; length: number }[] },
  maxMatchesPerFile: number,
): SearchFile | undefined {
  const matches: SearchMatch[] = []
  let count = 0
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const hits = matcher.test(line)
    if (hits.length === 0) continue
    count += hits.length
    const hit = hits[0]
    if (hit === undefined) continue
    // Every hit counts towards `count`; only the first few are kept.
    if (matches.length < maxMatchesPerFile) {
      matches.push({
        path,
        line: index + 1,
        column: hit.column,
        length: hit.length,
        text: clipLine(line, hit.column, hit.length),
      })
    }
  }
  return count === 0 ? undefined : { path, matches, count }
}

/** How many times `needle` occurs in `line` (non-overlapping, like the regex path). */
function literalCount(line: string, needle: string): number {
  let count = 0
  let at = 0
  for (;;) {
    at = line.indexOf(needle, at)
    if (at === -1) return count
    count++
    at += needle.length
  }
}

/**
 * Map over `items` with at most `limit` promises in flight, preserving order.
 * A rejection propagates (the search itself has no failing item: `scanFile`
 * reports "no match" instead).
 */
async function mapPool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** A positive integer option, clamped to `fallback` when absent or invalid. */
function bound(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(Math.floor(value), fallback))
}

/**
 * The `search` server half as a Cordis plugin object (shaped like `gitHalf`).
 *
 * It needs the mount's `fs`, and `onMount` callbacks run while the mount fiber
 * is still applying — the `fs` half's own `provide` has not landed yet (a
 * `provide` is an effect, visible once the fiber activates). The service is
 * therefore registered with a **lazy** lookup of `fs` (see `SearchService`):
 * by the time a page searches, the mount is up.
 */
export const searchHalf = {
  name: 'search',
  inject: ['diorama'],
  apply(ctx: { diorama: { mounts: Mounts } }) {
    ctx.diorama.mounts.onMount(mountCtx => {
      const mount = mountCtx as unknown as MountFiberContext
      if (typeof mount.provide !== 'function') return
      // `fs` is looked up when a search actually runs (see `SearchService`):
      // this callback runs while the mount fiber is still applying, so `fs`
      // is not provided yet. The lookup goes through the mount context, so it
      // finds this mount's own `fs` and not a sibling's.
      const service = new SearchService(() => {
        const fs = mount.get?.('fs')
        if (!(fs instanceof FsService)) throw rpcError('ESERVICE', 'no "fs" on this mount; search is unavailable')
        return fs
      })
      mount.provide('search', service)
      // The cached texts are this mount's memory: drop them with it.
      return () => service.close()
    })
  },
}

/** The parts of a mount context this half uses (declared locally on purpose). */
interface MountFiberContext {
  provide?(name: string, value: unknown): unknown
  get?(name: string): unknown
}
