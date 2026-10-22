/**
 * Repository discovery: the git repositories a mounted directory contains
 * (contract.md §3.2, v0.10).
 *
 * A mount is a *directory*, not a repository. One directory may hold several
 * repositories side by side (`apps/api/.git`, `apps/web/.git`) and a
 * repository may hold another one below it (a nested checkout, a vendored
 * dependency that is its own repository). Discovery walks down from the mount
 * root, claims every directory that is a repository root, and **does not
 * descend into it** — the repositories inside are found by continuing the walk
 * from the outside, which is what keeps each repository's own view whole.
 *
 * What counts as a repository root, without asking git (one process per
 * candidate directory would cost more than the walk itself):
 *
 * - a directory holding `.git` (a directory, or a *file* — a submodule, a
 *   `git worktree`, a `--separate-git-dir` checkout);
 * - a bare repository (a directory with `HEAD`, `objects/` and `refs/`).
 *
 * The walk is pruned by the mount's ignore rules (`node_modules`, `.git`,
 * whatever `diorama.toml` says) and bounded twice: by depth and by how many
 * repositories it may report. Both are configuration, not constants, because a
 * deep monorepo and a shallow workspace want different answers.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createIgnore, DEFAULT_IGNORE, type IgnoreRules } from '../shared/ignore.ts'

/** How deep the walk goes below the mount root, unless configured (v0.10). */
export const DEFAULT_GIT_MAX_DEPTH = 3

/** How many repositories one mount may report, unless configured (v0.10). */
export const DEFAULT_GIT_MAX_REPOS = 32

/** How many directories the walk visits at once (a wide tree is not a storm). */
const WALK_CONCURRENCY = 16

/** One repository a mount contains. */
export interface DiscoveredRepo {
  /** Path relative to the mount root, POSIX (`''` = the mount root itself). */
  path: string
  /** Absolute path of the working tree (or of the bare repository). */
  root: string
}

export interface DiscoverOptions {
  /** Mount root, absolute. */
  root: string
  /** Ignore patterns pruned from the walk (default: the kernel's). */
  ignore?: readonly string[]
  /** How many levels below the root to look (0 = the root only). */
  maxDepth?: number
  /** Stop after this many repositories. */
  maxRepos?: number
}

export interface DiscoverResult {
  /** Repositories found, shallowest first, then by path. */
  repos: DiscoveredRepo[]
  /**
   * The walk stopped early: `maxRepos` was reached, or a directory level held
   * more entries than it may queue. The list is a prefix, not the whole truth.
   */
  truncated: boolean
}

/** Whether the directory with these entries is a repository root (no git process). */
function isRepositoryRoot(names: ReadonlySet<string>): boolean {
  if (names.has('.git')) {
    // A `.git` **file** is a gitfile (submodule, worktree, separate-git-dir):
    // the repository is still rooted here.
    return true
  }
  // A bare repository has no `.git`: it *is* the git directory.
  if (!names.has('HEAD') || !names.has('objects') || !names.has('refs')) return false
  return true
}

/**
 * Walk `root` and return every repository in it (contract.md §3.2).
 *
 * A directory that is itself a repository root is claimed and **not** walked
 * into: its own files are that repository's business, and the repositories
 * nested below it are discovered as *its* inner repositories by the caller
 * (which needs that nesting to know what to hide from the outer view).
 */
export async function discoverRepositories(options: DiscoverOptions): Promise<DiscoverResult> {
  const root = resolve(options.root)
  const maxDepth = options.maxDepth ?? DEFAULT_GIT_MAX_DEPTH
  const maxRepos = options.maxRepos ?? DEFAULT_GIT_MAX_REPOS
  const ignore: IgnoreRules = createIgnore(options.ignore ?? DEFAULT_IGNORE)
  const repos: DiscoveredRepo[] = []
  let truncated = false

  /** One directory to visit: absolute path, its mount-relative path, its depth. */
  interface Level {
    dir: string
    path: string
    depth: number
  }

  let frontier: Level[] = [{ dir: root, path: '', depth: 0 }]
  while (frontier.length > 0) {
    if (repos.length >= maxRepos) {
      truncated = true
      break
    }
    const next: Level[] = []
    // Read one level in bounded batches: a wide directory is one `readdir`,
    // not one per child.
    for (let start = 0; start < frontier.length; start += WALK_CONCURRENCY) {
      const batch = frontier.slice(start, start + WALK_CONCURRENCY)
      const scanned = await Promise.all(batch.map(async level => {
        let entries: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[]
        try {
          entries = await readdir(level.dir, { withFileTypes: true })
        } catch {
          return { level, names: undefined as ReadonlySet<string> | undefined, entries: [] }
        }
        return { level, names: new Set(entries.map(entry => entry.name)), entries }
      }))
      for (const { level, names, entries } of scanned) {
        if (names === undefined) continue // unreadable: not a repository, not a failure
        if (isRepositoryRoot(names)) {
          if (repos.length >= maxRepos) {
            truncated = true
            break
          }
          repos.push({ path: level.path, root: level.dir })
          // Keep walking: a repository may hold another one (a nested checkout,
          // a vendored dependency). The nesting is what lets the outer view hide
          // the inner repository's files (see `GitRepoView`).
        }
        if (level.depth >= maxDepth) continue
        for (const entry of entries) {
          if (entry.name === '.git') continue
          const childPath = level.path === '' ? entry.name : `${level.path}/${entry.name}`
          // A symlinked directory is not followed: the walk would leave the
          // mount, and a link to an ancestor would never end.
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue
          if (ignore.matches(childPath, 'dir')) continue
          next.push({ dir: join(level.dir, entry.name), path: childPath, depth: level.depth + 1 })
        }
      }
      if (repos.length >= maxRepos) break
    }
    frontier = next
  }
  // Shallowest first, then by path: a stable order is what the views show and
  // what the RPC service names are derived from.
  repos.sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path))
  return { repos, truncated }
}

function depthOf(path: string): number {
  return path === '' ? 0 : path.split('/').length
}

/**
 * The repositories strictly **inside** `repoPath` (a discovered repo path),
 * as repo-relative paths. The caller needs this to hide a nested repository's
 * files from the outer one: git reports them (an untracked directory, or a
 * submodule's tree), but they belong to the inner repository.
 */
export function nestedPaths(repos: readonly DiscoveredRepo[], repoPath: string): string[] {
  const prefix = repoPath === '' ? '' : `${repoPath}/`
  const out: string[] = []
  for (const repo of repos) {
    if (repo.path === repoPath) continue
    if (prefix !== '' && !repo.path.startsWith(prefix)) continue
    if (prefix === '' && repo.path === '') continue
    out.push(prefix === '' ? repo.path : repo.path.slice(prefix.length))
  }
  return out
}

/** Absolute path of a discovered repository's root (helper for callers). */
export function repoRootOf(mountRoot: string, repoPath: string): string {
  return repoPath === '' ? resolve(mountRoot) : join(resolve(mountRoot), repoPath)
}

/** Read a `.git` file's `gitdir:` target (used by tests and diagnostics). */
export async function readGitFile(dir: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(dir, '.git'), 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(text)
    return match?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** Whether `path` is a directory (used by callers that need the distinction). */
export async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory(), () => false)
}
