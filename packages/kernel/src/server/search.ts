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
 * A search walks the tree breadth-first with a small worker pool: a content
 * search over a large directory reads many files, and one `Promise.all` over
 * all of them would open as many descriptors as there are files.
 */
import { readFile } from 'node:fs/promises'
import { fsError, rpcError } from '../shared/errors.ts'
import {
  clipLine,
  contentMatcher,
  fuzzyMatch,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES_PER_FILE,
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

declare module 'cordis' {
  interface Context {
    /** Read-only search over the mounted directory. Present on mount contexts only. */
    search: SearchService
  }
}

/** Files read at once by a content search (descriptors stay bounded). */
const CONCURRENCY = 16

/** One queued path of a walk: the file itself and its directory. */
interface WalkEntry {
  path: RelPath
  kind: 'file' | 'dir'
}

const METHODS: MethodDescriptor[] = [{ name: 'search', arity: 2 }]

/**
 * Read-only search rooted at one mounted directory (contract.md §3.9).
 * Instances are created per mount, like `FsService`.
 */
export class SearchService {
  /** The mount's file service: the only door to disk. */
  private readonly resolveFs: () => FsService

  /**
   * `fs` is resolved **on first use**, not at construction: a mount's services
   * land when its fiber activates (a `provide` is an effect), and this service
   * is registered from `onMount` — before that. By the time a page searches,
   * the mount is up. A function also keeps the service independent of which
   * context object the lookup goes through.
   */
  constructor(fs: FsService | (() => FsService)) {
    this.resolveFs = typeof fs === 'function' ? fs : () => fs
  }

  /** The mount's `fs`, resolved now (throws if the mount is being torn down). */
  private get fs(): FsService {
    return this.resolveFs()
  }

  /** The methods the RPC channel may proxy (contract.md §4). */
  describe(): MethodDescriptor[] {
    return METHODS
  }

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
      throw fsError('EINVAL', `the query is longer than ${SEARCH_MAX_QUERY_CHARS} characters`)
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
    const matcher = contentMatcher({
      query,
      ...(options.caseSensitive === true ? { caseSensitive: true } : {}),
      ...(options.wholeWord === true ? { wholeWord: true } : {}),
      ...(options.regex === true ? { regex: true } : {}),
    })
    if (matcher === undefined) throw fsError('EINVAL', 'the query is not a valid regular expression')
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
      candidates.push(entry.path)
      return true
    })
    const scanned = await mapPool(candidates, CONCURRENCY, path => this.scanFile(path, matcher, options.maxMatchesPerFile))
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
  private async scanFile(
    path: RelPath,
    matcher: { test(line: string): { column: number; length: number }[] },
    maxMatchesPerFile: number,
  ): Promise<SearchFile | undefined> {
    let text: string
    try {
      const bytes = await readFile(resolveInside(this.fs.root, path))
      if (bytes.includes(0)) return undefined // binary: no lines to search
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    } catch {
      return undefined // vanished or unreadable between listing and reading
    }
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
 * therefore registered with a **lazy** lookup of `fs` (see
 * `SearchService`): by the time a page searches, the mount is up.
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
    })
  },
}

/** The parts of a mount context this half uses (declared locally on purpose). */
interface MountFiberContext {
  provide?(name: string, value: unknown): unknown
  get?(name: string): unknown
}
