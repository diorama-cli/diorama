/**
 * The optional ripgrep engine behind `ctx.search` (contract.md §3.9).
 *
 * The kernel reads through `ctx.fs` and nothing else, so ripgrep is never
 * handed a **directory**: `fs.list` still decides which paths exist (and
 * therefore still owns `ignore`, contract.md §3.1). ripgrep only gets the
 * explicit file list and answers "which lines of these files match".
 *
 * That split is why the ignore rules can be passed along unchanged: the walk has
 * already applied them, and ripgrep runs with `--no-ignore` so it cannot
 * apply a second (different) opinion from `.gitignore`.
 *
 * The engine is **optional**. A page without the binary — or a query it cannot
 * answer faithfully — falls back to the JavaScript scanner in `search.ts`,
 * which stays the definition of "match" (contract.md §3.9).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { RelPath } from '../shared/types.ts'

/** Bytes of `rg` output accepted before the call is abandoned (a runaway match). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** Where the engine's binary is, or `undefined` when there is none. */
export type RgPath = () => string | undefined

/** One query as the engine needs it. */
export interface RgQuery {
  /** The pattern, already in ripgrep's dialect (see `rgArgs`). */
  pattern: string
  caseSensitive: boolean
  /** The pattern is a regular expression (otherwise `--fixed-strings`). */
  regex: boolean
  /** Whole word: the caller wraps the pattern, because the JS engine defines it. */
  wholeWord: boolean
}

/** A run that failed in a way that means "use the JavaScript scanner instead". */
export class RgUnavailable extends Error {}

/**
 * Build the argument list for one search.
 *
 * `--no-ignore` is deliberate: the file list already reflects the mount's
 * `ignore` rules, and ripgrep reading `.gitignore` would add a second opinion
 * (contract.md §3.1 says `list` is the only enforcement point).
 *
 * `--max-columns` is **not** passed. It makes ripgrep drop the match text of
 * a long line, and the contract needs the line to show the hit (§3.9); the
 * preview is clipped by `clipLine` instead.
 */
export function rgArgs(query: RgQuery, files: readonly RelPath[], namesOnly = false): string[] {
  const args = namesOnly
    ? ['--files-with-matches', '--no-config', '--no-ignore', '--hidden', '--no-messages', '--threads', '4']
    : ['--json', '--no-config', '--no-ignore', '--hidden', '--no-messages', '--threads', '4']
  args.push(query.caseSensitive ? '--case-sensitive' : '--ignore-case')
  // `--engine auto` lets ripgrep pick PCRE2 for the constructs its default
  // engine refuses (look-around, backreferences) — the ones JavaScript accepts.
  if (query.regex || query.wholeWord) args.push('--engine', 'auto')
  if (query.regex || query.wholeWord) args.push('--regexp', query.pattern)
  else args.push('--fixed-strings', '--regexp', query.pattern)
  args.push('--', ...files)
  return args
}

/**
 * Ask the engine which of `files` contain the query — nothing more.
 *
 * Only the **file list** is taken from the answer: lines, columns and previews
 * are produced by the JavaScript scanner over that narrowed set. Two reasons:
 * the contract's `column` is in characters while ripgrep reports bytes, and
 * ripgrep's per-hit JSON grows with the number of **hits** (a common word in a
 * big tree is ~10 MB of frames) while `-l` grows with the number of matching
 * **files**. Narrowing is where the engine's speed is worth having; deciding
 * what a match *is* stays in one place.
 */
export async function rgCandidates(
  binary: string,
  root: string,
  query: RgQuery,
  files: readonly RelPath[],
): Promise<RelPath[]> {
  if (files.length === 0) return []
  const args = rgArgs(query, files, true)
  const out = await run(binary, args, root)
  return out
    .split('\n')
    .map(line => (line.startsWith('./') ? line.slice(2) : line))
    .filter(line => line !== '')
}

/** Spawn one ripgrep and collect its stdout; any failure means "fall back". */
function run(binary: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args as string[],
      { cwd, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        // Exit code 1 is "no match", which is a perfectly good answer.
        if (error !== null && (error as { code?: unknown }).code !== 1) {
          reject(new RgUnavailable(error.message))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/** Whether the binary at `path` is a runnable ripgrep. */
export async function rgWorks(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}


/**
 * Where the bundled ripgrep lives, or `undefined` when this install has none.
 *
 * The package is an **optional** dependency: a kernel built without it (or a
 * platform with no prebuilt binary) simply uses the JavaScript scanner. The
 * lookup is lazy and cached, so the first search pays for it and no later one
 * does.
 */
let rgPath: string | undefined | null = null

export function defaultRgPath(): string | undefined {
  if (rgPath !== null) return rgPath
  rgPath = undefined
  try {
    // `createRequire` keeps this working in the ESM build while the package
    // stays a plain CommonJS module.
    const required = createRequire(import.meta.url) as (id: string) => { rgPath?: string }
    const resolved = required('@vscode/ripgrep')?.rgPath
    if (typeof resolved === 'string' && existsSync(resolved)) rgPath = resolved
  } catch {
    // Not installed: the JavaScript scanner is the whole engine.
  }
  return rgPath
}

/** Forget the cached lookup (tests that install or hide the binary). */
export function resetRgPath(): void {
  rgPath = null
}

