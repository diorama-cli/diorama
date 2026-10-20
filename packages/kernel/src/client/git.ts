/**
 * Client half of `ctx.git` (contract.md §3.2, §4): the read-only repository view
 * of this mount, obtained through the RPC proxy.
 *
 * Optional by contract: a mount outside a git working tree has no `git` service
 * at all, so the page asks through `optionalGit()` instead of assuming.
 */
import type {
  BlobResult,
  CommitDetail,
  DiffEntry,
  DiffResult,
  DiffScope,
  GitLogEntry,
  GitStatusEntry,
  RelPath,
} from '../shared/types.ts'
import type { RpcClient } from './rpc.ts'

/** The proxyable methods of the server's `GitService`. */
export const GIT_METHODS = ['status', 'diff', 'log', 'show', 'showCommit', 'blob'] as const

export interface GitClient {
  status(): Promise<GitStatusEntry[]>
  diff(scope?: DiffScope): Promise<DiffResult>
  log(options?: { limit?: number; path?: RelPath }): Promise<GitLogEntry[]>
  show(commit: string, path: RelPath): Promise<DiffEntry>
  showCommit(commit: string): Promise<CommitDetail>
  blob(commit: string, path: RelPath): Promise<BlobResult>
}

/** Build the `mountCtx.git` face over the RPC channel. */
export function createGitClient(rpc: RpcClient): GitClient {
  const remote = rpc.service<GitClient>('git', GIT_METHODS)
  return {
    status: () => remote.status(),
    diff: (scope = {}) => remote.diff(scope),
    log: (options = {}) => remote.log(options),
    show: (commit, path) => remote.show(commit, path),
    showCommit: commit => remote.showCommit(commit),
    blob: (commit, path) => remote.blob(commit, path),
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
