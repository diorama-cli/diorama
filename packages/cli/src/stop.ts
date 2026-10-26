/**
 * `diorama stop [dir]` (contract.md §7.6): unmount one directory — the current
 * one when no argument is given — and leave the gateway (and every other mount)
 * running. `--all` stops every mount of this gateway.
 *
 * The selection is **pure** (mount list + paths in, plan out) so `node --test`
 * can pin the three decisions that matter: the current directory, a directory
 * *inside* a mount, and `--all`. Nothing here touches the gateway.
 */
import { resolve, sep } from 'node:path'
import type { MountStatus } from 'diorama-kernel/server'

/** What `diorama stop` was asked to do (parsed, not yet resolved). */
export interface StopOptions {
  /** The directory the user named; absent = the current directory. */
  target?: string
  /** `--all`: stop every mount of this gateway. */
  all: boolean
  /** `--json`: one machine-readable document instead of prose. */
  json: boolean
}

export interface ParsedStopArgs {
  options: StopOptions
  /** Usage problem; when set the caller prints it and exits 2. */
  error?: string
}

/** Parse `diorama stop`'s own argv (one directory, or `--all`, plus `--json`). */
export function parseStopArgs(argv: readonly string[]): ParsedStopArgs {
  let target: string | undefined
  let all = false
  let json = false
  for (const arg of argv) {
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg.startsWith('-')) return { options: { ...(target === undefined ? {} : { target }), all, json }, error: `unknown option "${arg}" for stop` }
    if (target !== undefined) {
      return {
        options: { target, all, json },
        error: `stop takes one directory (got "${target}" and "${arg}")`,
      }
    }
    target = arg
  }
  if (all && target !== undefined) {
    return { options: { target, all, json }, error: 'stop takes either a directory or --all, not both' }
  }
  return { options: { ...(target === undefined ? {} : { target }), all, json } }
}

/** The two forms of the path `stop` was given (see {@link planStop}). */
export interface StopPaths {
  /** `resolve(input)`: always known, even when the directory is already gone. */
  resolved: string
  /** `realpath(resolved)` when it resolved — mount roots are realpaths. */
  real?: string
}

/** What this call will unmount. */
export interface StopPlan {
  /** `--all` was given. */
  all: boolean
  /** The absolute path asked for (absent for `--all`). */
  target?: string
  /** The mounts to unmount, in mount order. */
  mounts: MountStatus[]
  /**
   * Set when the target was **not** a mount root: the root of the mount that
   * contains it (the deepest one, when mounts nest).
   */
  containing?: string
}

/** Whether `path` is `root` or lies under it (separator-aware, no `/a/bc` vs `/a/b`). */
function within(root: string, path: string): boolean {
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** The deepest mount whose root contains `path` (nested mounts: the inner one wins). */
function deepestContaining(mounts: readonly MountStatus[], path: string): MountStatus | undefined {
  return mounts
    .filter(mount => within(mount.root, path))
    .sort((a, b) => b.root.length - a.root.length)[0]
}

/**
 * Decide what to unmount.
 *
 * Rules (contract.md §7.6):
 * 1. `--all` → every mount, even zero (an empty list is not an error).
 * 2. A mount root **equal** to the target (realpath first, then the plain
 *    resolved path — a deleted directory still matches by string).
 * 3. Otherwise the **deepest mount containing** the target: `diorama stop` in
 *    `proj/src` stops the mount of `proj`. A mount *inside* the target is
 *    **not** touched — `stop` never reaches sideways into a parent directory.
 *
 * `error: 'ENOMOUNT'` means nothing matched; the caller decides how loud that is
 * (it is a successful no-op, like `gateway stop` when nothing runs).
 */
export function planStop(
  mounts: readonly MountStatus[],
  options: StopOptions,
  paths: StopPaths,
): { plan?: StopPlan; error?: 'ENOMOUNT' } {
  if (options.all) return { plan: { all: true, mounts: [...mounts] } }
  const candidates = paths.real === undefined ? [paths.resolved] : [paths.real, paths.resolved]
  for (const wanted of candidates) {
    const exact = mounts.find(mount => mount.root === wanted)
    if (exact !== undefined) return { plan: { all: false, target: paths.resolved, mounts: [exact] } }
  }
  for (const wanted of candidates) {
    const containing = deepestContaining(mounts, wanted)
    if (containing !== undefined) {
      return { plan: { all: false, target: paths.resolved, mounts: [containing], containing: containing.root } }
    }
  }
  return { error: 'ENOMOUNT' }
}

/**
 * The human lines `diorama stop` prints (contract.md §7.6). `plan.mounts` is
 * what was **actually** unmounted, so the caller can report a partial run.
 */
export function stopLines(plan: StopPlan, name = 'diorama'): string[] {
  if (plan.all) {
    if (plan.mounts.length === 0) return ['no mounts to stop']
    const count = plan.mounts.length
    const lines = [`${name} stopped ${count} mount${count === 1 ? '' : 's'}`]
    for (const mount of plan.mounts) lines.push(`  [${mount.mountId}] ${mount.root}  ${mount.url}`)
    return lines
  }
  const [mount] = plan.mounts
  if (mount === undefined) return ['nothing to stop']
  const lines = [`${name} stopped ${mount.root}`, `  [mount:${mount.mountId}] ${mount.url}`]
  if (plan.containing !== undefined && plan.target !== undefined && plan.target !== mount.root) {
    lines.push(`  (matched the mount containing ${plan.target})`)
  }
  return lines
}

/**
 * The `--json` document: the stopped mounts with the URL they served (the URL
 * is the one thing a caller cannot recompute after the fact), plus the target.
 * `target` is `null` for `--all`.
 */
export function stopDocument(plan: StopPlan): Record<string, unknown> {
  return {
    stopped: plan.mounts.map(mount => ({ mountId: mount.mountId, root: mount.root, url: mount.url })),
    target: plan.all ? null : plan.target ?? null,
    all: plan.all,
  }
}

/**
 * "Nothing matched" — a **successful** no-op (exit 0, like `gateway stop` when
 * nothing runs), said with the list of mounts: a mistyped path and an empty
 * gateway look the same otherwise.
 */
export function noMountMessage(target: string, mounts: readonly MountStatus[], name = 'diorama'): string[] {
  const lines = [`no mount for "${target}" (run "${name} ls" to see the mounts)`]
  if (mounts.length === 0) return lines
  for (const mount of mounts) lines.push(`  [${mount.mountId}] ${mount.root}`)
  return lines
}

/** `resolve(input)` against a working directory (the CLI's `process.cwd()`). */
export function stopPath(input: string | undefined, cwd: string): string {
  return resolve(cwd, input ?? '.')
}
