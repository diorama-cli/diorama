/**
 * Client half of `ctx.search` (contract.md §3.9): a typed face over the mount's
 * search service, reached through the RPC proxy like `fs` and `git`.
 *
 * The service itself is provided by the `search` piece (it walks the tree with
 * `ctx.fs`, so it needs nothing the kernel alone has). A mount without that
 * piece answers `ESERVICE`, which is why this is a factory over the channel
 * rather than a field on the mount handle: the page asks, it does not assume.
 */
import type { SearchOptions, SearchResult } from '../shared/search.ts'
import type { RelPath } from '../shared/types.ts'
import type { RpcClient } from './rpc.ts'

/** The proxyable methods of the search service. */
export const SEARCH_METHODS = ['search', 'paths'] as const

export interface SearchClient {
  /** Search the mount by name or by content (contract.md §3.9). */
  search(query: string, options?: SearchOptions): Promise<SearchResult>
  /**
   * Every file path of the mount (or of one subtree), for quick open
   * (contract.md §3.9). One call instead of one per directory: the walk runs on
   * the server, where the tree already is.
   */
  paths(scope?: RelPath): Promise<RelPath[]>
}

/** Build the `mountCtx.search` face over the RPC channel. */
export function createSearchClient(rpc: RpcClient): SearchClient {
  // The service's methods are the whole face, so the proxy is typed directly
  // (an `Omit` of it would leave nothing to declare).
  const remote = rpc.service<SearchClient>('search', SEARCH_METHODS)
  return {
    search: (query, options = {}) => remote.search(query, options),
    paths: (scope = '') => remote.paths(scope),
  }
}

export type { SearchFile, SearchKind, SearchMatch, SearchOptions, SearchResult } from '../shared/search.ts'
