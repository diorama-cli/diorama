/**
 * Client half of `ctx.git` (contract.md §3.2, §4): the read-only view of the
 * repositories this mount contains, obtained through the RPC proxy.
 *
 * A mount may hold several repositories (v0.10), so the surface is:
 *
 * - `repos()` — which repositories exist, shallowest first;
 * - every other method — the whole mount, or one repository when it is named
 *   (`repo`, or a `path` that decides its repository by itself).
 *
 * Optional by contract: a mount with no repository at all has no `git` service,
 * so the page asks through `hasGit()` instead of assuming.
 */
import type {
  BlobResult,
  CommitDetail,
  DiffEntry,
  DiffResult,
  DiffScope,
  GitLogEntry,
  GitRepoInfo,
  GitStatusEntry,
  RelPath,
} from '../shared/types.ts'
import type { RpcClient } from './rpc.ts'

/** The proxyable methods of the server's `GitService`. */
export const GIT_METHODS = ['repos', 'status', 'diff', 'log', 'show', 'showCommit', 'blob'] as const

export interface GitLogOptions {
  limit?: number
  path?: RelPath
  /** Only this repository (default: the mount's own). */
  repo?: RelPath
}

export interface GitClient {
  /** The repositories of this mount, shallowest first (v0.10). */
  repos(): Promise<GitRepoInfo[]>
  /** Every change, every repository; or one repository when `repo` is given. */
  status(repo?: RelPath): Promise<GitStatusEntry[]>
  diff(scope?: DiffScope): Promise<DiffResult>
  log(options?: GitLogOptions): Promise<GitLogEntry[]>
  show(commit: string, path: RelPath, repo?: RelPath): Promise<DiffEntry>
  showCommit(commit: string, repo?: RelPath): Promise<CommitDetail>
  blob(commit: string, path: RelPath, repo?: RelPath): Promise<BlobResult>
}

/** Build the `mountCtx.git` face over the RPC channel. */
export function createGitClient(rpc: RpcClient): GitClient {
  const remote = rpc.service<GitClient>('git', GIT_METHODS)
  return {
    repos: () => remote.repos(),
    status: repo => (repo === undefined ? remote.status() : remote.status(repo)),
    diff: (scope = {}) => remote.diff(scope),
    log: (options = {}) => remote.log(options),
    show: (commit, path, repo) => (repo === undefined ? remote.show(commit, path) : remote.show(commit, path, repo)),
    showCommit: (commit, repo) => (repo === undefined ? remote.showCommit(commit) : remote.showCommit(commit, repo)),
    blob: (commit, path, repo) => (repo === undefined ? remote.blob(commit, path) : remote.blob(commit, path, repo)),
  }
}

/**
 * Whether this mount has any repository, without throwing when it has none: a
 * `repos()` call rejects with `ESERVICE` when no service was provided.
 */
export async function hasGit(git: GitClient): Promise<boolean> {
  try {
    const repos = await git.repos()
    return repos.length > 0
  } catch (error) {
    if ((error as { code?: string }).code === 'ESERVICE') return false
    throw error
  }
}
