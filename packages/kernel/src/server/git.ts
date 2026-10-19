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
import type { DiffEntry, DiffResult, DiffScope, GitLogEntry, GitStatusEntry, RelPath } from '../shared/types.ts'
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

const METHODS: MethodDescriptor[] = [
  { name: 'status', arity: 0 },
  { name: 'diff', arity: 1 },
  { name: 'log', arity: 1 },
]

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
    if (scope.base !== undefined && scope.base !== 'HEAD') {
      throw gitError('EINVAL', `diff base must be 'HEAD', got ${JSON.stringify(scope.base)}`)
    }
    const mountPath = scope.path === undefined ? undefined : normalizeMountPath(this.root, scope.path)
    const scopePath = scope.scope === undefined ? '' : normalizeMountPath(this.root, scope.scope)
    if (mountPath !== undefined && scope.scope !== undefined && !within(mountPath, scopePath)) {
      throw gitError('EINVAL', `${scope.path} is not inside ${scope.scope || '/'}`)
    }
    // The mount itself is a subtree of the repository: everything below is
    // filtered by mount-relative paths, so a repository path never escapes it.
    const changes = (await this.status()).filter(entry => {
      if (mountPath !== undefined) return entry.file === mountPath
      return within(entry.file, scopePath)
    })
    if (mountPath !== undefined) {
      const info = await this.pathKind(mountPath).catch(() => 'missing' as const)
      if (info === 'missing') throw gitError('ENOENT', `${mountPath} does not exist`)
    }
    const result: DiffResult = { entries: [], truncated: false }
    let bytes = 0
    let lines = 0
    for (const change of changes) {
      if (result.truncated) break
      const entry = await this.diffOne(change)
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

  /** One file's diff against `HEAD`, or an `error` entry when git refuses it. */
  private async diffOne(change: GitStatusEntry): Promise<DiffResult['entries'][number]> {
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
    const args = ['diff', '--no-color', '--no-ext-diff', '-M', 'HEAD', '--', repoPath]
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
