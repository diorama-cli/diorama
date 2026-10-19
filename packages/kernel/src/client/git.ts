/**
 * Client half of `ctx.git` (contract.md §3.2, §4): the read-only repository view
 * of this mount, obtained through the RPC proxy.
 *
 * Optional by contract: a mount outside a git working tree has no `git` service
 * at all, so the page asks through `optionalGit()` instead of assuming.
 */
import type { DiffResult, DiffScope, GitLogEntry, GitStatusEntry, RelPath } from '../shared/types.ts'
import type { RpcClient } from './rpc.ts'

/** The proxyable methods of the server's `GitService`. */
export const GIT_METHODS = ['status', 'diff', 'log'] as const

export interface GitClient {
  status(): Promise<GitStatusEntry[]>
  diff(scope?: DiffScope): Promise<DiffResult>
  log(options?: { limit?: number; path?: RelPath }): Promise<GitLogEntry[]>
}

/** Build the `mountCtx.git` face over the RPC channel. */
export function createGitClient(rpc: RpcClient): GitClient {
  const remote = rpc.service<GitClient>('git', GIT_METHODS)
  return {
    status: () => remote.status(),
    diff: (scope = {}) => remote.diff(scope),
    log: (options = {}) => remote.log(options),
  }
}

/**
 * Whether this mount has a repository, without throwing when it does not: a
 * `status()` call rejects with `ESERVICE` when no service was provided.
 */
export async function hasGit(git: GitClient): Promise<boolean> {
  try {
    await git.status()
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ESERVICE') return false
    throw error
  }
}
