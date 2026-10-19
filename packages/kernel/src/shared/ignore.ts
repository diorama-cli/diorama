/**
 * The ignore rules that hide entries from `fs.list` (contract.md §3.1, §4.1).
 *
 * The syntax is a **subset of gitignore**:
 * - `name` — that name at any depth;
 * - `dir/` — only directories (a trailing `/` restricts the match);
 * - `a/b` — anchored to the mount root (any pattern with an inner `/` is);
 * - `*` `?` `[...]` — within one path segment (they never cross `/`);
 * - `**` — crosses segments (`**\/x` any depth, `x/**` everything below).
 *
 * Differences from gitignore, on purpose (M2): `.gitignore` files are not read,
 * there is no negation (`!`), and `#` only starts a comment at line start of
 * the parsed text (the array form has no comments at all).
 */

/** One compiled pattern. */
interface Rule {
  source: string
  /** Matches directories only. */
  dirOnly: boolean
  /** Compiled against the full relative path. */
  regex: RegExp
}

export interface IgnoreRules {
  /** The patterns as configured (for diagnostics). */
  readonly patterns: readonly string[]
  /** Whether `path` (relative, `/`-separated, no leading `/`) is hidden. */
  matches(path: string, kind: 'file' | 'dir' | ''): boolean
}

const NO_OP: IgnoreRules = {
  patterns: [],
  matches: () => false,
}

/** Escape a literal run for a regex. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Translate one glob (no leading/trailing `/`) into regex source. */
function globToRegexSource(glob: string): string {
  let out = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**` crosses segments; absorb a following `/` so `**/x` also matches `x`.
        const after = glob.slice(index + 2)
        if (after.startsWith('/')) {
          out += '(?:[^/]*/)*'
          index += 2
        } else {
          out += '.*'
          index += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '[') {
      const end = glob.indexOf(']', index + 1)
      if (end !== -1) {
        const body = glob.slice(index + 1, end)
        // A `]` inside a class must be escaped for the regex engine.
        const escaped = body.startsWith('!') ? `^${body.slice(1)}` : body
        out += `[${escaped.replace(/\]/g, '\\]').replace(/\^/g, (match, offset: number) => (offset === 0 ? match : '\\^'))}]`
        index = end
        continue
      }
    }
    out += escape(char as string)
  }
  return out
}

/** Compile one pattern; `undefined` for an unusable one. */
function compile(source: string): Rule | undefined {
  let pattern = source.trim()
  if (pattern === '' || pattern.startsWith('#')) return undefined
  const dirOnly = pattern.endsWith('/')
  if (dirOnly) pattern = pattern.slice(0, -1)
  // A leading `/` anchors; an *inner* slash does too (gitignore). Only the
  // stripped pattern decides: the leading slash itself is not an inner one.
  const anchored = pattern.startsWith('/')
  pattern = pattern.replace(/^\//, '')
  const innerSlash = pattern.includes('/')
  if (pattern === '') return undefined
  if (anchored || innerSlash) return { source, dirOnly, regex: new RegExp(`^${globToRegexSource(pattern)}$`) }
  // Unanchored: the name at any depth (`^`-or-`/`-prefixed, end-anchored), which
  // also covers the root itself.
  const body = globToRegexSource(pattern)
  return { source, dirOnly, regex: new RegExp(`(?:^|/)${body}$`) }
}

/**
 * Build the matcher for a list of patterns. Empty / blank input is a no-op
 * matcher (that is what `--all` and `ignore = []` mean).
 */
export function createIgnore(patterns: readonly string[], warn?: (message: string) => void): IgnoreRules {
  const rules: Rule[] = []
  for (const source of patterns) {
    const rule = compile(source)
    if (rule === undefined) {
      if (source.trim() !== '' && !source.trim().startsWith('#')) warn?.(`ignore pattern "${source}" matches nothing (invalid)`)
      continue
    }
    rules.push(rule)
  }
  if (rules.length === 0) return patterns.length === 0 ? NO_OP : { ...NO_OP, patterns: [...patterns] }
  return {
    patterns: [...patterns],
    matches(path, kind) {
      if (path === '') return false
      for (const rule of rules) {
        if (rule.dirOnly && kind === 'file') continue
        if (rule.regex.test(path)) return true
      }
      return false
    },
  }
}

/** The built-in defaults (`diorama.toml` `ignore` replaces them). */
export const DEFAULT_IGNORE = ['.git', 'node_modules'] as const
