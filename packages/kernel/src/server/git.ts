/**
 * `ctx.git` server half: a read-only view of the git repository a mount lives
 * in (contract.md §3.2).
 *
 * Read-only by construction: the service runs only `rev-parse`, `status`,
 * `diff` and `log`, always with `--no-color`, and never writes the index or the
 * working tree. Paths go in and out relative to the **mount root** (like
 * `ctx.fs`); the service translates them to repository paths, since a mount may
 * be a subdirectory of a larger repository.
 *
 * Existence is part of the contract: a mount that is not inside a working tree
 * (or a machine without `git`) gets **no `git` service at all**, so plugins
 * detect the capability with `inject: { optional: ['git'] }` instead of
 * catching errors.
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { gitError } from '../shared/errors.ts'
import type { MethodDescriptor } from '../shared/rpc.ts'
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
import { resolveInside } from './fs.ts'
import type { MountInfo, Mounts } from './plugins.ts'
import {
  DEFAULT_GIT_MAX_DEPTH,
  discoverRepositories,
} from './repos.ts'

declare module 'cordis' {
  interface Context {
    /** Read-only git view. Present on mount contexts of repositories only. */
    git: GitService
  }
}

/** Bytes of unified diff text one `diff()` call may return (contract.md §3.2). */
export const MAX_DIFF_BYTES = 4 * 1024 * 1024

/** Lines of unified diff text one `diff()` call may return (contract.md §3.2). */
export const MAX_DIFF_LINES = 2000

/** Default `log()` limit; and the largest accepted (contract.md §3.2). */
export const DEFAULT_LOG_LIMIT = 50
export const MAX_LOG_LIMIT = 500

/** Bytes of one file's content `blob()` may return (same threshold as `readText`). */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024

const METHODS: MethodDescriptor[] = [
  // v0.10: every method takes an optional trailing `repo` (the mount's own
  // repository when absent), so the arities are the widest accepted shape.
  { name: 'repos', arity: 0 },
  { name: 'status', arity: 1 },
  { name: 'diff', arity: 1 },
  { name: 'log', arity: 1 },
  { name: 'show', arity: 3 },
  { name: 'showCommit', arity: 2 },
  { name: 'blob', arity: 3 },
]

/** A commit argument as callers pass it (full sha, short sha, `HEAD~1`). */
function normalizeCommit(commit: unknown): string {
  if (typeof commit !== 'string' || commit === '' || commit.length > 256) {
    throw gitError('EINVAL', `a commit must be a non-empty string, got ${JSON.stringify(commit)}`)
  }
  // Revision syntax git understands; anything else is a malformed argument.
  if (!/^[A-Za-z0-9_./^~@{}:-]+$/.test(commit) || commit.includes('..')) {
    throw gitError('EINVAL', `not a commit or revision: ${JSON.stringify(commit)}`)
  }
  return commit
}

/** Whether `path` is `root` or below it (both absolute). */
function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/** `realpath` when the path exists, `undefined` otherwise (never throws). */
function realpathSyncSafe(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** A `git` invocation that failed (non-zero exit, or no binary at all). */
class GitProcessError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

/**
 * The environment git runs with: the gateway's, minus every `GIT_*` variable,
 * plus the three this service sets.
 *
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_CONFIG*`
 * and the rest of git's environment are **stronger than `-C` / `cwd`**: a
 * gateway started from a shell that carried them would answer every mount
 * with whichever repository that shell pointed at (one mount's files, another
 * mount's changes). The directory a mount serves is decided by the mount, so
 * the repository is too; never by the environment the daemon inherited.
 */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith('GIT_')) continue
    env[name] = value
  }
  env.GIT_TERMINAL_PROMPT = '0' // never prompt (credentials)
  env.GIT_OPTIONAL_LOCKS = '0' // never take a lock we did not ask for
  env.LC_ALL = 'C'
  return env
}

/** Run git in `cwd`; text output for `log`/`rev-parse`, raw for others. Never interactive. */
function runGit(cwd: string, args: readonly string[], binary = false): Promise<Buffer | string> {
  return new Promise((settle, fail) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        encoding: binary ? 'buffer' : 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: gitEnvironment(),
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const code = (error as { code?: string | number }).code
          const detail = String(stderr ?? '').trim() || (error as Error).message
          fail(new GitProcessError(detail, typeof code === 'string' ? code : undefined))
          return
        }
        settle(stdout)
      },
    )
  })
}

/** Repository paths are POSIX-separated; a mount path is too (contract.md §3.1). */
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/** The working tree root of `dir`, or `undefined` when it is not inside one. */
export async function findRepoRoot(dir: string): Promise<string | undefined> {
  let output: Buffer | string
  try {
    output = await runGit(dir, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    // A missing binary is a different fact from "not a repository"; the caller
    // logs the difference (`signalOf`), but neither provides `ctx.git`.
    throw error
  }
  const root = String(output).trim()
  if (root === '') return undefined
  return realpath(root).catch(() => root)
}

/** One changed path, classified from the porcelain status (contract.md §3.2). */
function classify(code: string): GitStatusEntry['kind'] {
  const [x = ' ', y = ' '] = code
  if (code === '??') return 'untracked'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  if (x === 'R' || y === 'R') return 'renamed'
  // Added to the index (A ) or to the working tree of an untracked file (A, covered above).
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  return 'modified'
}

interface PorcelainRecord {
  status: string
  file: string
  oldFile?: string
}

/** Parse `git status --porcelain=v1 -z` (NUL-terminated, renames carry two paths). */
export function parsePorcelainZ(output: string): PorcelainRecord[] {
  const records: PorcelainRecord[] = []
  const parts = output.split('\0')
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part === undefined || part.length < 4) continue
    const status = part.slice(0, 2)
    const file = part.slice(3)
    if (status[0] === 'R' || status[0] === 'C') {
      // A rename is `XY <new>\0<old>\0`.
      const oldFile = parts[++index]
      records.push(oldFile === undefined ? { status, file } : { status, file, oldFile })
      continue
    }
    records.push({ status, file })
  }
  return records
}

/** Is `path` inside `scope` (both repository-relative, POSIX)? '' is every path. */
function within(path: string, scope: string): boolean {
  if (scope === '') return true
  return path === scope || path.startsWith(`${scope}/`)
}

/**
 * One repository's view inside a mount (contract.md §3.2, v0.10).
 *
 * A mount may contain several repositories, so this is **not** the service
 * plugins talk to: {@link GitService} is, and it forwards to the view that owns
 * the path. A view knows one working tree and answers only for paths below it
 * that are not inside a repository nested within it.
 */
export class GitRepoView {
  /** The mount root (absolute, realpath'ed). */
  readonly root: string

  /** The working tree root (absolute, realpath'ed). */
  readonly repoRoot: string

  /** The repository root as a mount path, POSIX ('' = the mount root itself). */
  readonly repoPath: string

  /**
   * The mount root as a repository path, POSIX ('' = the same directory).
   * A mount below the working tree is a *prefix* of its files' repository
   * paths (`src/` → `src/app.js`), never a path segment above them.
   *
   * `undefined` when the repository is **inside** the mount instead (a nested
   * checkout): then {@link repoPath} is the prefix and the mount is the wider
   * of the two, so there is no mount prefix to prepend.
   */
  private readonly mountInRepo: string | undefined

  /**
   * Repositories nested inside this one, as **repository** paths. Their files
   * belong to them: a nested checkout is an untracked directory to the outer
   * repository, and a submodule's tree is the submodule's business, so the
   * outer view must not report (or diff) paths below them.
   */
  private readonly nested: string[]

  /**
   * @param root mount root, absolute
   * @param repoRoot working tree root, absolute (realpath'ed; `rev-parse` output)
   * @param nested repositories inside this one, **mount**-relative POSIX paths
   *
   * Both sides must be in the same path space: a mount reached through a
   * symlink (`/tmp/x` vs `/private/tmp/x` on macOS) would otherwise make
   * `mountInRepo` a `../..`-shaped prefix that matches no status entry. The
   * mount registry realpaths its roots, but a service built by hand (a test, a
   * future caller) may not — normalise here.
   */
  constructor(root: string, repoRoot: string, nested: readonly string[] = []) {
    this.repoRoot = resolve(repoRoot)
    this.root = resolve(root)
    if (!isInside(this.root, this.repoRoot)) {
      // The mount is not under this working tree as spelled: try resolving it
      // through symlinks before giving up (the mount root may be a symlink).
      const resolved = realpathSyncSafe(this.root)
      if (resolved !== undefined && isInside(resolved, this.repoRoot)) this.root = resolved
    }
    const mountInsideRepo = isInside(this.root, this.repoRoot)
    const repoInsideMount = isInside(this.repoRoot, this.root)
    if (!mountInsideRepo && !repoInsideMount) {
      // Neither contains the other: not a view this mount can offer.
      throw gitError('ENOTREPO', `the repository ${this.repoRoot} is not inside the mount ${this.root}`)
    }
    // Exactly one of the two prefixes exists. A mount **below** its repository
    // (the common case since v0.5) keeps a mount prefix; a repository **inside**
    // the mount (v0.10: several repositories, one of them nested here) has the
    // repository as the prefix and no mount prefix at all.
    this.mountInRepo = mountInsideRepo && !repoInsideMount ? toPosix(relative(this.repoRoot, this.root)) : undefined
    this.repoPath = repoInsideMount && !mountInsideRepo ? toPosix(relative(this.root, this.repoRoot)) : ''
    // Nesting is compared in **mount** space, the space callers hand paths in.
    this.nested = [...nested]
  }

  /**
   * Whether a mount path belongs to a repository nested in this one. The
   * nested root itself is included: its tree is the inner repository's.
   */
  private isNested(path: RelPath): boolean {
    for (const inner of this.nested) {
      if (inner === '') continue
      if (path === inner || path.startsWith(`${inner}/`)) return true
    }
    return false
  }

  /** The methods the RPC channel may proxy (contract.md §4). */
  describe(): MethodDescriptor[] {
    return METHODS
  }

  /** Every changed path of the working tree (unstaged, staged and untracked). */
  async status(): Promise<GitStatusEntry[]> {
    let output: Buffer | string
    try {
      output = await runGit(this.repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    } catch (error) {
      throw this.translate(error)
    }
    // A mount below the working tree only sees its own subtree of the status;
    // a repository inside the mount sees its whole tree.
    const prefix = this.mountInRepo === undefined || this.mountInRepo === '' ? '' : `${this.mountInRepo}/`
    const entries: GitStatusEntry[] = []
    for (const record of parsePorcelainZ(String(output)).filter(item => item.file.startsWith(prefix))) {
      // A nested repository's files are its own view's business (v0.10).
      const file = this.toMountPath(record.file)
      if (file === undefined) continue // outside the mount: not this page's business
      // A nested repository is an *untracked directory* to the outer one, and
      // git spells that with a trailing slash: compare without it.
      if (this.isNested(file.replace(/\/+$/, ''))) continue
      const kind = classify(record.status)
      const oldPath = record.oldFile === undefined ? undefined : this.toMountPath(record.oldFile)
      entries.push({
        file,
        kind,
        status: record.status,
        repo: this.repoPath,
        ...(oldPath === undefined ? {} : { oldPath }),
      })
    }
    return entries
  }

  /**
   * Unified diffs of the working tree against `HEAD` (contract.md §3.2):
   * one entry per changed file under `scope`, or just `path`.
   */
  async diff(scope: DiffScope = {}): Promise<DiffResult> {
    // `'HEAD'` (default) and `'index'` are names of ours; anything else must be
    // a revision git can resolve (checked below, before listing changes).
    const base = scope.base ?? 'HEAD'
    // `'unborn'` is ours too: a repository with no commits has nothing to
    // compare the working tree **with**, and `git diff HEAD` answers "bad
    // revision 'HEAD'". Every change is then a new file, which is what the
    // reader would see anyway (the file's own content, not a diff).
    const resolved =
      base === 'index' ? 'index'
      : base === 'HEAD' ? ((await this.hasHead()) ? 'HEAD' : 'unborn')
      : await this.resolveRevision(base)
    const mountPath = scope.path === undefined ? undefined : normalizeMountPath(this.root, scope.path)
    const scopePath = scope.scope === undefined ? '' : normalizeMountPath(this.root, scope.scope)
    if (mountPath !== undefined && scope.scope !== undefined && !within(mountPath, scopePath)) {
      throw gitError('EINVAL', `${scope.path} is not inside ${scope.scope || '/'}`)
    }
    // The mount itself is a subtree of the repository: everything below is
    // filtered by mount-relative paths, so a repository path never escapes it.
    let changes = (await this.status()).filter(entry => {
      if (mountPath !== undefined) return entry.file === mountPath
      return within(entry.file, scopePath)
    })
    // The index has no room for untracked files: "what did I stage" does not
    // include what was never added (contract.md §3.2, v0.6).
    if (resolved === 'index') changes = changes.filter(entry => entry.kind !== 'untracked')
    // Nothing to compare with: every change is a new file, and an "addition"
    // with no text is how the renderer reads one (it shows the file's content).
    if (resolved === 'unborn') changes = changes.map(entry => ({ ...entry, kind: 'added' as const }))
    if (mountPath !== undefined) {
      const info = await this.pathKind(mountPath).catch(() => 'missing' as const)
      if (info === 'missing') throw gitError('ENOENT', `${mountPath} does not exist`)
    }
    const result: DiffResult = { entries: [], truncated: false }
    let bytes = 0
    let lines = 0
    for (const change of changes) {
      if (result.truncated) break
      const entry = await this.diffOne(change, resolved)
      if (!('error' in entry) && entry.text !== undefined) {
        const entryBytes = Buffer.byteLength(entry.text, 'utf8')
        const entryLines = countLines(entry.text)
        if (bytes + entryBytes > MAX_DIFF_BYTES || lines + entryLines > MAX_DIFF_LINES) {
          // The whole call is full: return what fits, flag the call.
          result.truncated = true
          if (bytes === 0 && lines === 0) {
            result.entries.push({ ...entry, text: clip(entry.text, MAX_DIFF_BYTES, MAX_DIFF_LINES), truncated: true })
          }
          break
        }
        bytes += entryBytes
        lines += entryLines
      }
      result.entries.push(entry)
    }
    return result
  }

  /** Recent commits, newest first (contract.md §3.2). */
  async log(options: { limit?: number; path?: RelPath } = {}): Promise<GitLogEntry[]> {
    const limit = options.limit ?? DEFAULT_LOG_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
      throw gitError('EINVAL', `log limit must be an integer in 1..${MAX_LOG_LIMIT}, got ${String(options.limit)}`)
    }
    // A repository that has never been committed to has no history, and git
    // says so by **failing** ("your current branch 'master' does not have any
    // commits yet"). That is a state, not an error: the answer is no commits.
    if (!(await this.hasHead())) return []
    const path = options.path === undefined ? undefined : normalizeMountPath(this.root, options.path)
    const args = [
      'log',
      `--max-count=${limit}`,
      '--no-color',
      '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct',
      '--',
      path === undefined ? this.mountInRepo || '.' : this.toRepoPath(path),
    ]
    let output: Buffer | string
    try {
      output = await runGit(this.repoRoot, args)
    } catch (error) {
      throw this.translate(error)
    }
    const entries: GitLogEntry[] = []
    for (const line of String(output).split('\n')) {
      if (line === '') continue
      const [sha, shortSha, subject, author, seconds] = line.split('\x1f')
      if (sha === undefined || shortSha === undefined) continue
      entries.push({
        sha,
        shortSha,
        subject: subject ?? '',
        author: author ?? '',
        at: Number(seconds ?? 0) * 1000,
      })
    }
    return entries
  }

  /**
   * One file's change in one commit, against its parent (`contract.md §3.2`,
   * v0.6). A root commit is compared with the empty tree.
   */
  async show(commit: string, path: RelPath): Promise<DiffEntry> {
    const revision = normalizeCommit(commit)
    const mountPath = normalizeMountPath(this.root, path)
    if (mountPath === '') throw gitError('EINVAL', 'show() needs a file path, not the mount root')
    const sha = await this.resolveRevision(revision)
    const repoPath = this.toRepoPath(mountPath)
    const text = await this.run(['show', '--no-color', '--no-ext-diff', '-M', '--format=', sha, '--', repoPath])
    if (text.trim() === '') {
      // No diff: either the file did not change in this commit, or it is not
      // in it at all. The second is a missing path, the first an empty change.
      const present = await this.existsIn(sha, repoPath)
      const inParent = await this.existsIn(`${sha}^`, repoPath)
      if (!present && !inParent) throw gitError('ENOENT', `${path} does not exist in ${revision}`)
      return { file: mountPath, kind: 'modified', status: 'M ', repo: this.repoPath, text: '' }
    }
    return this.toEntry(mountPath, text, kindFromDiff(text))
  }

  /** One commit in full: message and the files it touched (contract.md §3.2). */
  async showCommit(commit: string): Promise<CommitDetail> {
    const revision = normalizeCommit(commit)
    const sha = await this.resolveRevision(revision)
    const header = await this.run(['show', '--no-color', '--no-patch', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%B', sha])
    const [full, short, subject, author, seconds, ...rest] = header.split('\x1f')
    if (full === undefined || short === undefined) throw gitError('EIO', `git show returned no commit for ${revision}`)
    const detail: CommitDetail = {
      sha: full,
      shortSha: short,
      subject: subject ?? '',
      author: author ?? '',
      at: Number(seconds ?? 0) * 1000,
      message: rest.join('\x1f'),
      repo: this.repoPath,
      files: [],
    }
    // The file list is the diff of the commit against its parent, one entry
    // per file, under the same 4 MiB / 2000 line account `diff()` uses.
    const names = await this.run(['show', '--no-color', '--name-status', '-z', '--format=', '-M', sha])
    let bytes = 0
    let lines = 0
    for (const change of this.parseCommitFiles(names)) {
      const text = await this.run(['show', '--no-color', '--no-ext-diff', '-M', '--format=', sha, '--', this.toRepoPath(change.file)])
      const entry = this.toEntry(change.file, text, change.kind, change.oldPath, change.status)
      const entryBytes = entry.text === undefined ? 0 : Buffer.byteLength(entry.text, 'utf8')
      const entryLines = entry.text === undefined ? 0 : countLines(entry.text)
      if (bytes + entryBytes > MAX_DIFF_BYTES || lines + entryLines > MAX_DIFF_LINES) {
        detail.truncated = true
        if (bytes === 0 && lines === 0 && entry.text !== undefined) {
          detail.files.push({ ...entry, text: clip(entry.text, MAX_DIFF_BYTES, MAX_DIFF_LINES), truncated: true })
        }
        break
      }
      bytes += entryBytes
      lines += entryLines
      detail.files.push(entry)
    }
    return detail
  }

  /** One file's content in one commit, not a diff (contract.md §3.2). */
  async blob(commit: string, path: RelPath): Promise<BlobResult> {
    const revision = normalizeCommit(commit)
    const mountPath = normalizeMountPath(this.root, path)
    if (mountPath === '') throw gitError('EINVAL', 'blob() needs a file path, not the mount root')
    const sha = await this.resolveRevision(revision)
    const repoPath = this.toRepoPath(mountPath)
    const spec = `${sha}:${repoPath}`
    // `cat-file -s` first: never ask git for megabytes we would only clip. A
    // path that is not in this commit is ENOENT (a missing path), not EIO;
    // any other failure keeps the translated code.
    const sizeText = await this.run(['cat-file', '-s', spec]).catch((error: unknown) => {
      const coded = error as { code?: string; message?: string }
      if (/does not exist|Not a valid object name|path .* does not exist/i.test(coded.message ?? '')) {
        throw gitError('ENOENT', `${path} does not exist in ${revision}`, error)
      }
      throw error
    })
    const size = Number(sizeText.trim())
    if (!Number.isFinite(size)) throw gitError('EIO', `git cat-file reported no size for ${spec}`)
    const bytes = await this.runBytes(['cat-file', '-p', spec])
    if (bytes.includes(0)) return { binary: true, size }
    let text = bytes.toString('utf8')
    if (size > MAX_BLOB_BYTES) {
      text = clip(text, MAX_BLOB_BYTES, Number.MAX_SAFE_INTEGER)
      return { text, size, truncated: true }
    }
    return { text, size }
  }

  /**
   * Whether the branch has a commit yet. A repository that was `git init`ed and
   * never committed to has an **unborn** HEAD: `rev-parse HEAD` fails, and so do
   * `log` and `diff HEAD`. Asking first is what turns those failures into the
   * answers the state deserves (no commits; everything is new).
   */
  private async hasHead(): Promise<boolean> {
    try {
      await runGit(this.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
      return true
    } catch {
      return false
    }
  }

  /** Resolve a revision to a full sha; `EINVAL` for malformed, `ENOENT` for unknown. */
  private async resolveRevision(revision: string): Promise<string> {
    if (typeof revision !== 'string' || revision === '' || revision.length > 256) {
      throw gitError('EINVAL', `a revision must be a non-empty string, got ${JSON.stringify(revision)}`)
    }
    if (!/^[A-Za-z0-9_./^~@{}:-]+$/.test(revision) || revision.includes('..')) {
      throw gitError('EINVAL', `not a revision: ${JSON.stringify(revision)}`)
    }
    // `--verify --quiet` answers with a sha or a non-zero exit; `^{commit}`
    // rejects trees and blobs, so a resolved revision is always a commit.
    try {
      const output = await runGit(this.repoRoot, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
      const sha = String(output).trim()
      if (sha === '') throw gitError('ENOENT', `no such commit: ${revision}`)
      return sha
    } catch (error) {
      if (error instanceof GitProcessError) throw gitError('ENOENT', `no such commit: ${revision}`, error)
      throw error
    }
  }

  /** Whether a repository path exists at a revision (`false` for a bad revision). */
  private async existsIn(revision: string, repoPath: string): Promise<boolean> {
    try {
      await runGit(this.repoRoot, ['cat-file', '-e', `${revision}:${repoPath}`])
      return true
    } catch {
      return false
    }
  }

  /** `git <args>` in the repository as text, translated errors. */
  private async run(args: string[]): Promise<string> {
    try {
      return String(await runGit(this.repoRoot, args))
    } catch (error) {
      throw this.translate(error)
    }
  }

  /** `git <args>` in the repository as bytes, translated errors. */
  private async runBytes(args: string[]): Promise<Buffer> {
    try {
      const output = await runGit(this.repoRoot, args, true)
      return Buffer.isBuffer(output) ? output : Buffer.from(String(output), 'utf8')
    } catch (error) {
      throw this.translate(error)
    }
  }

  /** Entries of `--name-status -z` output for one commit, mount-relative. */
  private parseCommitFiles(output: string): { file: RelPath; oldPath?: RelPath; kind: GitStatusEntry['kind']; status: string }[] {
    const parts = output.split('\0')
    const files: { file: RelPath; oldPath?: RelPath; kind: GitStatusEntry['kind']; status: string }[] = []
    for (let index = 0; index < parts.length; index++) {
      const code = parts[index]?.trim()
      if (code === undefined || code === '') continue
      const letter = code[0]
      const first = parts[++index]
      if (first === undefined) break
      const kind = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'R' || letter === 'C' ? 'renamed' : letter === 'T' ? 'modified' : 'modified'
      let repoPath = first
      let oldRepoPath: string | undefined
      if (letter === 'R' || letter === 'C') {
        oldRepoPath = first
        repoPath = parts[++index] ?? first
      }
      const file = this.toMountPath(repoPath)
      if (file === undefined) continue // outside the mount
      if (this.isNested(file)) continue // a nested repository's file
      const oldPath = oldRepoPath === undefined ? undefined : this.toMountPath(oldRepoPath)
      files.push({ file, kind, status: `${letter} `, ...(oldPath === undefined ? {} : { oldPath }) })
    }
    return files
  }

  /** Attach diff text (or `binary` / `truncated`) to a change description. */
  private toEntry(
    file: RelPath,
    text: string,
    kind: GitStatusEntry['kind'],
    oldPath?: RelPath,
    status = kind === 'added' ? 'A ' : kind === 'deleted' ? 'D ' : 'M ',
  ): DiffEntry {
    const base: DiffEntry = { file, kind, status, repo: this.repoPath, ...(oldPath === undefined ? {} : { oldPath }) }
    if (looksBinary(text)) return { ...base, binary: true }
    if (Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES || countLines(text) > MAX_DIFF_LINES) {
      return { ...base, text: clip(text, MAX_DIFF_BYTES, MAX_DIFF_LINES), truncated: true }
    }
    return { ...base, text }
  }

  /** One file's diff against `base`, or an `error` entry when git refuses it. */
  private async diffOne(
    change: GitStatusEntry,
    comparison: 'HEAD' | 'index' | 'unborn' | string = 'HEAD',
  ): Promise<DiffResult['entries'][number]> {
    const base: DiffEntry = {
      file: change.file,
      kind: change.kind,
      status: change.status,
      repo: this.repoPath,
      ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
    }
    if (change.kind === 'untracked') {
      // `git diff` does not show untracked files; the renderer (and the reader)
      // sees the whole file as an addition. Report it as such, without text:
      // that is a read (`ctx.fs`), not a diff.
      return { ...base, kind: 'added' }
    }
    if (comparison === 'unborn') {
      // No commit to compare with, so there is no diff to ask git for: the
      // whole file is new. Text stays absent — the renderer reads the file
      // (contract.md §3.2, the same shape as an untracked entry).
      return { ...base, kind: 'added' }
    }
    const repoPath = this.toRepoPath(change.file)
    // `git diff --cached` compares the index with HEAD — and with the **empty
    // tree** when there is no HEAD, which is exactly "everything is new" and
    // keeps working on an unborn branch (naming HEAD there is a hard failure).
    // A plain revision compares the working tree with it.
    const args = comparison === 'index'
      ? ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', '--', repoPath]
      : ['diff', '--no-color', '--no-ext-diff', '-M', comparison, '--', repoPath]
    let output: Buffer | string
    try {
      output = await runGit(this.repoRoot, args, true)
    } catch (error) {
      const mapped = this.translate(error)
      return { file: change.file, repo: this.repoPath, error: { code: mapped.code ?? 'EIO', message: mapped.message } }
    }
    const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output)
    if (text === '' && change.kind === 'added') {
      // A file staged as added but identical to HEAD does not happen; an empty
      // diff for a real change is a file git treats as binary — say so.
      return { ...base, binary: true }
    }
    if (looksBinary(text)) return { ...base, binary: true }
    const lines = countLines(text)
    if (Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES || lines > MAX_DIFF_LINES) {
      return { ...base, text: clip(text, MAX_DIFF_BYTES, MAX_DIFF_LINES), truncated: true }
    }
    return { ...base, text }
  }

  /** `kind` of a mount path: file, dir, or missing. */
  private async pathKind(path: RelPath): Promise<'file' | 'dir' | 'missing'> {
    const info = await stat(resolveInside(this.root, path)).catch(() => undefined)
    if (info === undefined) return 'missing'
    return info.isDirectory() ? 'dir' : 'file'
  }

  /**
   * A mount path → repository path (POSIX). Two directions, one translation:
   * a mount below its repository drops a prefix; a repository inside the mount
   * adds one (`repoPath`).
   */
  private toRepoPath(path: RelPath): string {
    if (this.mountInRepo === undefined) {
      // The repository is inside the mount: strip its own mount prefix.
      if (this.repoPath === '') return path
      if (path === this.repoPath) return ''
      return path.startsWith(`${this.repoPath}/`) ? path.slice(this.repoPath.length + 1) : path
    }
    if (this.mountInRepo === '') return path
    return path === '' ? this.mountInRepo : `${this.mountInRepo}/${path}`
  }

  /** A repository path → mount path, or `undefined` when it is outside the mount. */
  private toMountPath(repoPath: string): RelPath | undefined {
    if (this.mountInRepo === undefined) {
      // The repository is inside the mount: prefix its own mount path back.
      if (this.repoPath === '') return repoPath
      return repoPath === '' ? this.repoPath : `${this.repoPath}/${repoPath}`
    }
    if (this.mountInRepo === '') return repoPath
    if (repoPath === this.mountInRepo) return ''
    if (!repoPath.startsWith(`${this.mountInRepo}/`)) return undefined
    return repoPath.slice(this.mountInRepo.length + 1)
  }

  /**
   * Whether this view answers for a mount path: below the repository root, and
   * not inside a repository nested in this one (that one has its own view).
   */
  owns(path: RelPath): boolean {
    if (!within(path, this.repoPath)) return false
    return !this.isNested(path)
  }

  /** Map a failed git process to the contract's codes (contract.md §3.2). */
  private translate(error: unknown): Error & { code?: string } {
    if (error instanceof GitProcessError) {
      if (error.code === 'ENOENT') {
        // No `git` binary: the mount should have had no service at all; be loud.
        return gitError('EIO', 'the "git" executable is not on PATH', error)
      }
      const message = `git failed: ${error.message.split('\n')[0] ?? ''}`
      if (/not a git repository/i.test(error.message)) return gitError('ENOTREPO', message, error)
      return gitError('EIO', message, error)
    }
    return gitError('EIO', error instanceof Error ? error.message : String(error), error)
  }
}

/** Validate a plugin-supplied path and normalise it (no trailing slash). */
function normalizeMountPath(root: string, path: RelPath): RelPath {
  resolveInside(root, path) // EINVAL / EOUTSIDE, same rules as `ctx.fs`
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path
}

/** The change kind of a single-file `git show` output, from its `new file` / `deleted file` marker. */
function kindFromDiff(text: string): GitStatusEntry['kind'] {
  if (/^new file mode /m.test(text)) return 'added'
  if (/^deleted file mode /m.test(text)) return 'deleted'
  if (/^rename from /m.test(text)) return 'renamed'
  return 'modified'
}

/** `git diff` prints `Binary files … differ` for files it treats as binary. */
function looksBinary(text: string): boolean {
  return /^Binary files .* differ$/m.test(text)
}

function countLines(text: string): number {
  if (text === '') return 0
  let count = 0
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++
  return text.endsWith('\n') ? count : count + 1
}

/** Keep whole lines while both limits hold. */
function clip(text: string, maxBytes: number, maxLines: number): string {
  let bytes = 0
  let lines = 0
  let end = 0
  while (end < text.length && bytes < maxBytes && lines < maxLines) {
    const newline = text.indexOf('\n', end)
    const stop = newline === -1 ? text.length : newline + 1
    const chunk = text.slice(end, stop)
    bytes += Buffer.byteLength(chunk, 'utf8')
    if (bytes > maxBytes) break
    end = stop
    lines++
  }
  return text.slice(0, end)
}

/** Which directory a mount's repository root is, or why there is none. */
export async function detectRepository(root: string): Promise<{ repoRoot: string } | { reason: string }> {
  try {
    const repoRoot = await findRepoRoot(root)
    return repoRoot === undefined ? { reason: 'git rev-parse reported no working tree' } : { repoRoot }
  } catch (error) {
    if (error instanceof GitProcessError && error.code === 'ENOENT') {
      return { reason: 'the "git" executable is not on PATH' }
    }
    return {
      reason: error instanceof GitProcessError ? `not a git working tree (${firstLine(error.message)})` : String(error),
    }
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text
}

/**
 * `ctx.git` for one mount (contract.md §3.2, v0.10): the read-only view of
 * **every** repository the mounted directory contains.
 *
 * A mount is a directory; it may hold one repository, several side by side, or
 * a repository with more nested inside it. The methods therefore take the
 * repository they answer for (`repos()` lists them, and `repo` defaults to
 * the mount's own repository — the one rooted at the mount, else the first
 * found). One view per repository does the work; this class only routes.
 */
export class GitService {
  /** The mount root (absolute). */
  readonly root: string

  /** Every repository, shallowest first (contract.md §3.2). */
  readonly views: readonly GitRepoView[]

  /** The walk stopped early (depth/limit): the list is a prefix. */
  readonly truncated: boolean

  constructor(root: string, views: readonly GitRepoView[], truncated = false) {
    if (views.length === 0) throw gitError('ENOTREPO', `the mount ${root} contains no git repository`)
    this.root = resolve(root)
    this.views = views
    this.truncated = truncated
  }

  /** The methods the RPC channel may proxy (contract.md §4). */
  describe(): MethodDescriptor[] {
    return METHODS
  }

  /** The repositories of this mount, shallowest first (contract.md §3.2). */
  repos(): GitRepoInfo[] {
    return this.views.map(view => ({ path: view.repoPath, truncated: this.truncated }))
  }

  /**
   * The view that answers for a repository path. `undefined` is the mount's
   * own repository: the one rooted exactly at the mount, else the first found
   * (a mount below its repository, or one that only contains repositories).
   */
  private viewOf(repo: string | undefined): GitRepoView {
    if (repo === undefined || repo === '') {
      return this.views.find(view => view.repoPath === '') ?? (this.views[0] as GitRepoView)
    }
    const found = this.views.find(view => view.repoPath === repo)
    if (found === undefined) throw gitError('ENOTREPO', `no repository "${repo}" on this mount`)
    return found
  }

  /** The view that owns a mount path (the deepest repository containing it). */
  private viewOfPath(path: RelPath): GitRepoView {
    const normalized = path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path
    let best: GitRepoView | undefined
    for (const view of this.views) {
      if (!view.owns(normalized)) continue
      if (best === undefined || view.repoPath.length > best.repoPath.length) best = view
    }
    if (best === undefined) throw gitError('ENOTREPO', `${path} is not inside a repository of this mount`)
    return best
  }

  /**
   * Every changed path of every repository (contract.md §3.2). Each entry's
   * `repo` says which repository it belongs to; paths are mount-relative, so
   * the list is one flat surface the views group themselves.
   */
  async status(repo?: string): Promise<GitStatusEntry[]> {
    const views = repo === undefined ? this.views : [this.viewOf(repo)]
    const out: GitStatusEntry[] = []
    for (const view of views) {
      for (const entry of await view.status()) out.push({ ...entry, repo: view.repoPath })
    }
    return out
  }

  /** Unified diffs of one repository against `HEAD` (contract.md §3.2). */
  async diff(scope: DiffScope = {}): Promise<DiffResult> {
    // A scoped call names one repository; the whole-mount call spans them all
    // and keeps the per-call byte/line account shared across repositories.
    if (scope.repo !== undefined) return this.viewOf(scope.repo).diff(scope)
    if (scope.path !== undefined) {
      const view = this.viewOfPath(scope.path)
      return view.diff({ ...scope, repo: view.repoPath })
    }
    const result: DiffResult = { entries: [], truncated: false }
    let bytes = 0
    let lines = 0
    for (const view of this.views) {
      const part = await view.diff(scope)
      for (const entry of part.entries) {
        // An unreadable file carries an `error` and no text: it costs nothing
        // against the account, and stays in the list (one bad file is not the
        // whole answer).
        const text = 'text' in entry ? entry.text ?? '' : ''
        const entryBytes = Buffer.byteLength(text, 'utf8')
        const entryLines = countLines(text)
        if (bytes + entryBytes > MAX_DIFF_BYTES || lines + entryLines > MAX_DIFF_LINES) {
          result.truncated = true
          break
        }
        bytes += entryBytes
        lines += entryLines
        result.entries.push({ ...entry, repo: view.repoPath })
      }
      if (part.truncated) result.truncated = true
      if (result.truncated) break
    }
    return result
  }

  /** Recent commits of one repository, newest first (contract.md §3.2). */
  log(options: { limit?: number; path?: RelPath; repo?: string } = {}): Promise<GitLogEntry[]> {
    if (options.path !== undefined) return this.viewOfPath(options.path).log(options)
    return this.viewOf(options.repo).log(options)
  }

  /** One file's change in one commit (contract.md §3.2). */
  show(commit: string, path: RelPath, repo?: string): Promise<DiffEntry> {
    return this.viewOf(repo ?? this.viewOfPath(path).repoPath).show(commit, path)
  }

  /** One commit in full (contract.md §3.2). */
  showCommit(commit: string, repo?: string): Promise<CommitDetail> {
    return this.viewOf(repo).showCommit(commit)
  }

  /** One file's content in one commit (contract.md §3.2). */
  blob(commit: string, path: RelPath, repo?: string): Promise<BlobResult> {
    return this.viewOf(repo ?? this.viewOfPath(path).repoPath).blob(commit, path)
  }
}

/**
 * The `git` server half, shaped like `fsHalf` (contract.md §2.5): discovery is
 * asynchronous and `onMount` is not, so the probe runs on a fiber owned by the
 * mount and the service appears once it answers.
 */
export const gitHalf = {
  name: 'git',
  inject: ['diorama'],
  apply(root: { diorama: { mounts: Mounts } }) {
    root.diorama.mounts.onMount((mountCtx, info) => {
      const ctx = mountCtx as unknown as MountFiberContext
      if (typeof ctx.plugin !== 'function') return
      void (async () => {
        try {
          const fiber = ctx.plugin?.({
            name: `git:${info.mountId}`,
            async apply(inner: MountFiberContext) {
              const service = await openMount(info)
              if ('reason' in service) {
                console.error(`[mount:${info.mountId}] git: ${service.reason}`)
                return
              }
              provideGit(inner, service.service)
            },
          })
          // A PENDING fiber is not a failure: `apply` runs once the probe answers.
          await fiber
        } catch (error) {
          console.error(`[mount:${info.mountId}] git: ${(error as Error).message}`)
        }
      })()
    })
  },
}

/**
 * Discover the repositories of a mount and build its `ctx.git` (contract.md
 * §3.2, v0.10). A mount with no repository answers `{ reason }`: it gets **no
 * `git` service at all**, which is how a plugin detects the capability.
 */
export async function openMount(info: MountInfo): Promise<{ service: GitService } | { reason: string }> {
  const config = info.config?.git
  // A repository above the mount is *also* a repository of the mount (the
  // mount is a subdirectory of it, contract.md §3.2 since v0.5). The walk finds
  // what is below; `rev-parse` finds what contains. A mount that is exactly a
  // repository root is found by the walk, so the two never double up.
  const above = await enclosingRepository(info.root)
  const found = await discoverRepositories({
    root: info.root,
    ignore: config?.ignore ?? info.config?.ignore,
    maxDepth: config?.maxDepth,
    maxRepos: config?.maxRepos,
  })
  if (above !== undefined) {
    found.repos = [{ path: '', root: above }, ...found.repos.filter(repo => repo.path !== '')]
  }
  if (found.repos.length === 0) {
    // Distinguish "no repository here" from "no git binary": the second is a
    // machine problem the reader should hear about, the first is normal.
    const probe = await detectRepository(info.root)
    return { reason: 'reason' in probe ? probe.reason : `no git repository in ${info.root} (depth ${config?.maxDepth ?? DEFAULT_GIT_MAX_DEPTH})` }
  }
  const views: GitRepoView[] = []
  for (const repo of found.repos) {
    // Views take **mount** paths for their nesting (that is the space their
    // callers hand paths in); `nestedPaths` answers in repository space, so
    // translate here rather than inside every view.
    const nested = found.repos
      .filter(other => other.path !== repo.path && within(other.path, repo.path))
      .map(other => other.path)
    try {
      views.push(new GitRepoView(info.root, repo.root, nested))
    } catch (error) {
      // A repository whose working tree does not contain its own directory is
      // not something this mount can show; skip it, the rest still answer.
      console.error(`[mount:${info.mountId}] git: ${repo.path === '' ? '.' : repo.path}: ${(error as Error).message}`)
    }
  }
  if (views.length === 0) return { reason: `no usable git repository in ${info.root}` }
  return { service: new GitService(info.root, views, found.truncated) }
}

/**
 * The working tree that **contains** `dir` (a mount below its repository's
 * root, contract.md §3.2 since v0.5), or `undefined` when `dir` is not inside
 * one. A missing `git` binary is not "no repository": it is re-thrown so the
 * caller reports the machine problem instead of an empty mount.
 */
async function enclosingRepository(dir: string): Promise<string | undefined> {
  try {
    return await findRepoRoot(dir)
  } catch (error) {
    if (error instanceof GitProcessError && error.code === 'ENOENT') throw error
    return undefined
  }
}

/** The parts of a mount context this half uses (declared locally on purpose). */
interface MountFiberContext {
  plugin?(plugin: object): PromiseLike<unknown> | undefined
  provide?(name: string, value: unknown): unknown
}

/** Provide the service on a context (the mount fiber rolls it back on unmount). */
function provideGit(ctx: MountFiberContext, service: GitService): void {
  ctx.provide?.('git', service)
}
