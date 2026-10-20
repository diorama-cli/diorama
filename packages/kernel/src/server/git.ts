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
  GitStatusEntry,
  RelPath,
} from '../shared/types.ts'
import { resolveInside } from './fs.ts'
import type { Mounts } from './plugins.ts'

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
  { name: 'status', arity: 0 },
  { name: 'diff', arity: 1 },
  { name: 'log', arity: 1 },
  { name: 'show', arity: 2 },
  { name: 'showCommit', arity: 1 },
  { name: 'blob', arity: 2 },
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
        // Never prompt (credentials, hooks) and never take a lock we did not ask for.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
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

/** The service: one instance per mount that is inside a git working tree. */
export class GitService {
  /** The mount root (absolute, realpath'ed). */
  readonly root: string

  /** The working tree root (absolute, realpath'ed). */
  readonly repoRoot: string

  /**
   * The mount root as a repository path, POSIX ('' = the same directory).
   * A mount below the working tree is a *prefix* of its files' repository
   * paths (`src/` → `src/app.js`), never a path segment above them.
   */
  private readonly mountInRepo: string

  /**
   * @param root mount root, absolute
   * @param repoRoot working tree root, absolute (realpath'ed; `rev-parse` output)
   *
   * Both sides must be in the same path space: a mount reached through a
   * symlink (`/tmp/x` vs `/private/tmp/x` on macOS) would otherwise make
   * `mountInRepo` a `../..`-shaped prefix that matches no status entry. The
   * mount registry realpaths its roots, but a service built by hand (a test, a
   * future caller) may not — normalise here.
   */
  constructor(root: string, repoRoot: string) {
    this.repoRoot = resolve(repoRoot)
    this.root = resolve(root)
    if (!isInside(this.root, this.repoRoot)) {
      // The mount is not under this working tree as spelled: try resolving it
      // through symlinks before giving up (the mount root may be a symlink).
      const resolved = realpathSyncSafe(this.root)
      if (resolved !== undefined && isInside(resolved, this.repoRoot)) this.root = resolved
    }
    if (!isInside(this.root, this.repoRoot)) {
      // A mount outside its repository is not a repository mount: be loud,
      // and still answer with an empty surface rather than a wrong prefix.
      throw gitError('ENOTREPO', `the mount ${this.root} is not inside the working tree ${this.repoRoot}`)
    }
    this.mountInRepo = toPosix(relative(this.repoRoot, this.root))
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
    // A mount below the working tree only sees its own subtree of the status.
    const prefix = this.mountInRepo === '' ? '' : `${this.mountInRepo}/`
    const entries: GitStatusEntry[] = []
    for (const record of parsePorcelainZ(String(output)).filter(item => item.file.startsWith(prefix))) {
      const file = this.toMountPath(record.file)
      if (file === undefined) continue // outside the mount: not this page's business
      const kind = classify(record.status)
      const oldPath = record.oldFile === undefined ? undefined : this.toMountPath(record.oldFile)
      entries.push({
        file,
        kind,
        status: record.status,
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
    const resolved = base === 'HEAD' || base === 'index' ? base : await this.resolveRevision(base)
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
      return { file: mountPath, kind: 'modified', status: 'M ', text: '' }
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
    const base: DiffEntry = { file, kind, status, ...(oldPath === undefined ? {} : { oldPath }) }
    if (looksBinary(text)) return { ...base, binary: true }
    if (Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES || countLines(text) > MAX_DIFF_LINES) {
      return { ...base, text: clip(text, MAX_DIFF_BYTES, MAX_DIFF_LINES), truncated: true }
    }
    return { ...base, text }
  }

  /** One file's diff against `base`, or an `error` entry when git refuses it. */
  private async diffOne(change: GitStatusEntry, comparison: 'HEAD' | 'index' | string = 'HEAD'): Promise<DiffResult['entries'][number]> {
    const base: DiffEntry = {
      file: change.file,
      kind: change.kind,
      status: change.status,
      ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
    }
    if (change.kind === 'untracked') {
      // `git diff` does not show untracked files; the renderer (and the reader)
      // sees the whole file as an addition. Report it as such, without text:
      // that is a read (`ctx.fs`), not a diff.
      return { ...base, kind: 'added' }
    }
    const repoPath = this.toRepoPath(change.file)
    // `git diff --cached HEAD` compares the index with HEAD; a plain revision
    // compares the working tree with it.
    const args = comparison === 'index'
      ? ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', 'HEAD', '--', repoPath]
      : ['diff', '--no-color', '--no-ext-diff', '-M', comparison, '--', repoPath]
    let output: Buffer | string
    try {
      output = await runGit(this.repoRoot, args, true)
    } catch (error) {
      const mapped = this.translate(error)
      return { file: change.file, error: { code: mapped.code ?? 'EIO', message: mapped.message } }
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

  /** A mount path → repository path (POSIX). */
  private toRepoPath(path: RelPath): string {
    if (this.mountInRepo === '') return path
    return path === '' ? this.mountInRepo : `${this.mountInRepo}/${path}`
  }

  /** A repository path → mount path, or `undefined` when it is outside the mount. */
  private toMountPath(repoPath: string): RelPath | undefined {
    if (this.mountInRepo === '') return repoPath
    if (repoPath === this.mountInRepo) return ''
    if (!repoPath.startsWith(`${this.mountInRepo}/`)) return undefined
    return repoPath.slice(this.mountInRepo.length + 1)
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

/** The `git` server half, shaped like `fsHalf` (contract.md §2.5). */
export const gitHalf = {
  name: 'git',
  inject: ['diorama'],
  apply(root: { diorama: { mounts: Mounts } }) {
    root.diorama.mounts.onMount((mountCtx, info) => {
      const ctx = mountCtx as unknown as MountFiberContext
      if (typeof ctx.plugin !== 'function') return
      // Detection is asynchronous but `onMount` is not (contract.md §2.5): the
      // probe runs on a fiber owned by this mount, so the service appears once
      // it answers and an unmount in between takes both away.
      void (async () => {
        try {
          const fiber = ctx.plugin?.({
            name: `git:${info.mountId}`,
            async apply(inner: MountFiberContext) {
              const detected = await detectRepository(info.root)
              if ('reason' in detected) {
                console.error(`[mount:${info.mountId}] git: ${detected.reason}`)
                return
              }
              provideGit(inner, new GitService(info.root, detected.repoRoot))
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

/** The parts of a mount context this half uses (declared locally on purpose). */
interface MountFiberContext {
  plugin?(plugin: object): PromiseLike<unknown> | undefined
  provide?(name: string, value: unknown): unknown
}

/** Provide the service on a context (the mount fiber rolls it back on unmount). */
function provideGit(ctx: MountFiberContext, service: GitService): void {
  ctx.provide?.('git', service)
}
