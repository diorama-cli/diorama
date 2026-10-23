/**
 * Effective configuration (contract.md §4.1): `diorama.toml` + CLI + defaults,
 * merged once, here.
 *
 * Precedence is **CLI > diorama.toml > default**. The CLI therefore carries
 * `undefined` for "not given" (see `parseArgs`) — a CLI default would shadow
 * every toml value silently. Errors are fail loud: a syntax error, an unknown
 * key, or a wrong type prints the file and the reason and the CLI exits 2.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { DEFAULT_IGNORE } from '../shared/ignore.ts'
import { BUILTIN_PLUGIN_IDS } from './plan.ts'
import { DEFAULT_GIT_MAX_DEPTH, DEFAULT_GIT_MAX_REPOS } from './repos.ts'

/** The config file name looked up in the served directory and `$DIORAMA_HOME`. */
export const CONFIG_FILE = 'diorama.toml'

/** What `/plugin.json` carries and what the server acts on. */
export interface EffectiveConfig {
  host: string
  /** `0` = a free port chosen at listen time. */
  port: number
  /** Client plugin selection, in boot order. */
  plugins: string[]
  /** Ignore patterns hiding entries from `fs.list` (contract.md §3.1). */
  ignore: string[]
  watch: {
    debounceMs: number
    /** `false` makes `fs.watch` return a no-op disposer. */
    enabled: boolean
    /** Watched-directory cap per mount (contract.md §3.1). */
    maxDirectories: number
  }
  /** Repository discovery (contract.md §3.2, v0.10). */
  git: {
    /** Levels below the mount root that are searched for repositories. */
    maxDepth: number
    /** Repositories one mount reports at most. */
    maxRepos: number
    /** Patterns pruned from the walk; absent = the mount's `ignore`. */
    ignore?: string[]
  }
  /** HTML preview behaviour (contract.md §5.1). */
  html: {
    /** Whether the preview runs a page's scripts without asking, per file. */
    scripts: boolean
  }
}

/** What a `diorama.toml` may say (every field optional). */
export interface FileConfig {
  host?: string
  port?: number
  plugins?: string[]
  ignore?: string[]
  watch?: { debounceMs?: number; enabled?: boolean; maxDirectories?: number }
  git?: { maxDepth?: number; maxRepos?: number; ignore?: string[] }
  html?: { scripts?: boolean }
}

/** Where the configuration came from. */
export interface ConfigOrigin {
  /** Absolute path of the file read, or `undefined` for defaults only. */
  path?: string
}

export interface ResolveOptions {
  /** Directory being served (absolute). */
  root: string
  /** `DIORAMA_HOME`, defaulting to `~/.diorama`. */
  home?: string
  /** Explicit `--config <path>`; skips the lookup. */
  configPath?: string
  /** CLI values; `undefined` means "not given". */
  cli?: {
    host?: string
    port?: number
    plugins?: readonly string[]
    /** `--all`: no ignore rules at all. */
    all?: boolean
  }
  /** Read a file (injectable for tests). */
  readFile?: (path: string) => string
  exists?: (path: string) => boolean
}

/** Raised for a config file that cannot be used; the message names the file. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function defaultConfig(): EffectiveConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    plugins: [...BUILTIN_PLUGIN_IDS],
    ignore: [...DEFAULT_IGNORE],
    watch: { debounceMs: 300, enabled: true, maxDirectories: 64 },
    git: { maxDepth: DEFAULT_GIT_MAX_DEPTH, maxRepos: DEFAULT_GIT_MAX_REPOS },
    // Scripts stay off until the reader says so, per file (contract.md §5.1):
    // an HTML file is not trusted because it was opened.
    html: { scripts: false },
  }
}

/** `$DIORAMA_HOME` or `~/.diorama`. */
export function dioramaHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DIORAMA_HOME
  return home !== undefined && home !== '' ? resolve(home) : join(homedir(), '.diorama')
}

const ROOT_KEYS = new Set(['host', 'port', 'plugins', 'ignore', 'watch', 'git', 'html'])
const WATCH_KEYS = new Set(['debounceMs', 'enabled', 'maxDirectories'])
const GIT_KEYS = new Set(['maxDepth', 'maxRepos', 'ignore'])
const HTML_KEYS = new Set(['scripts'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new ConfigError(`${where} must be an array of strings`)
  }
  return [...(value as string[])]
}

/** Validate the parsed TOML against the schema; unknown keys fail loud. */
export function validateFileConfig(raw: unknown, where: string): FileConfig {
  if (!isRecord(raw)) throw new ConfigError(`${where}: the file must be a table`)
  const out: FileConfig = {}
  for (const key of Object.keys(raw)) {
    if (!ROOT_KEYS.has(key)) throw new ConfigError(`${where}: unknown key "${key}" (known: ${[...ROOT_KEYS].join(', ')})`)
  }
  if (raw.host !== undefined) {
    if (typeof raw.host !== 'string' || raw.host.trim() === '') throw new ConfigError(`${where}: "host" must be a non-empty string`)
    out.host = raw.host
  }
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || (raw.port as number) < 0 || (raw.port as number) > 65_535) {
      throw new ConfigError(`${where}: "port" must be an integer 0–65535`)
    }
    out.port = raw.port as number
  }
  if (raw.plugins !== undefined) out.plugins = stringArray(raw.plugins, `${where}: "plugins"`)
  if (raw.ignore !== undefined) out.ignore = stringArray(raw.ignore, `${where}: "ignore"`)
  if (raw.watch !== undefined) {
    if (!isRecord(raw.watch)) throw new ConfigError(`${where}: "watch" must be a table`)
    for (const key of Object.keys(raw.watch)) {
      if (!WATCH_KEYS.has(key)) throw new ConfigError(`${where}: unknown key "watch.${key}" (known: ${[...WATCH_KEYS].join(', ')})`)
    }
    const watch: FileConfig['watch'] = {}
    if (raw.watch.debounceMs !== undefined) {
      const value = raw.watch.debounceMs
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 60_000) {
        throw new ConfigError(`${where}: "watch.debounceMs" must be an integer 0–60000`)
      }
      watch.debounceMs = value as number
    }
    if (raw.watch.enabled !== undefined) {
      if (typeof raw.watch.enabled !== 'boolean') throw new ConfigError(`${where}: "watch.enabled" must be a boolean`)
      watch.enabled = raw.watch.enabled
    }
    if (raw.watch.maxDirectories !== undefined) {
      const value = raw.watch.maxDirectories
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 4096) {
        throw new ConfigError(`${where}: "watch.maxDirectories" must be an integer 1–4096`)
      }
      watch.maxDirectories = value as number
    }
    out.watch = watch
  }
  if (raw.git !== undefined) {
    if (!isRecord(raw.git)) throw new ConfigError(`${where}: "git" must be a table`)
    for (const key of Object.keys(raw.git)) {
      if (!GIT_KEYS.has(key)) throw new ConfigError(`${where}: unknown key "git.${key}" (known: ${[...GIT_KEYS].join(', ')})`)
    }
    const git: NonNullable<FileConfig['git']> = {}
    if (raw.git.maxDepth !== undefined) {
      const value = raw.git.maxDepth
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 64) {
        throw new ConfigError(`${where}: "git.maxDepth" must be an integer 0–64`)
      }
      git.maxDepth = value as number
    }
    if (raw.git.maxRepos !== undefined) {
      const value = raw.git.maxRepos
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 4096) {
        throw new ConfigError(`${where}: "git.maxRepos" must be an integer 1–4096`)
      }
      git.maxRepos = value as number
    }
    if (raw.git.ignore !== undefined) git.ignore = stringArray(raw.git.ignore, `${where}: "git.ignore"`)
    out.git = git
  }
  if (raw.html !== undefined) {
    if (!isRecord(raw.html)) throw new ConfigError(`${where}: "html" must be a table`)
    for (const key of Object.keys(raw.html)) {
      if (!HTML_KEYS.has(key)) throw new ConfigError(`${where}: unknown key "html.${key}" (known: ${[...HTML_KEYS].join(', ')})`)
    }
    const html: NonNullable<FileConfig['html']> = {}
    if (raw.html.scripts !== undefined) {
      if (typeof raw.html.scripts !== 'boolean') throw new ConfigError(`${where}: "html.scripts" must be a boolean`)
      html.scripts = raw.html.scripts
    }
    out.html = html
  }
  return out
}

/** Parse a `diorama.toml` text; failures name the file. */
export function parseConfigFile(text: string, where: string): FileConfig {
  let raw: unknown
  try {
    raw = parseToml(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ConfigError(`${where}: invalid TOML — ${detail}`)
  }
  return validateFileConfig(raw, where)
}

/**
 * Find and read the configuration. The served directory's own file wins; then
 * `$DIORAMA_HOME/diorama.toml`; otherwise defaults. Only the first file found
 * is read (no merging of files).
 */
export function loadFileConfig(options: ResolveOptions): { config: FileConfig; origin: ConfigOrigin } {
  const exists = options.exists ?? existsSync
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const candidates = options.configPath !== undefined
    ? [resolve(options.configPath)]
    : [join(options.root, CONFIG_FILE), join(options.home ?? dioramaHome(), CONFIG_FILE)]
  for (const path of candidates) {
    if (!exists(path)) {
      if (options.configPath !== undefined) throw new ConfigError(`--config ${path}: no such file`)
      continue
    }
    let text: string
    try {
      text = read(path)
    } catch (error) {
      throw new ConfigError(`${path}: cannot read (${(error as Error).message})`)
    }
    return { config: parseConfigFile(text, path), origin: { path } }
  }
  return { config: {}, origin: {} }
}

/** Merge defaults ← file ← CLI (contract.md §4.1). */
export function mergeConfig(file: FileConfig, cli: ResolveOptions['cli'] = {}): EffectiveConfig {
  const base = defaultConfig()
  const pick = <T>(...values: (T | undefined)[]): T | undefined => values.find(value => value !== undefined)
  return {
    host: pick(cli?.host, file.host) ?? base.host,
    port: pick(cli?.port, file.port) ?? base.port,
    plugins: [...(pick(cli?.plugins, file.plugins) ?? base.plugins)],
    ignore: cli?.all === true ? [] : [...(file.ignore ?? base.ignore)],
    watch: {
      debounceMs: file.watch?.debounceMs ?? base.watch.debounceMs,
      enabled: file.watch?.enabled ?? base.watch.enabled,
      maxDirectories: file.watch?.maxDirectories ?? base.watch.maxDirectories,
    },
    git: {
      maxDepth: file.git?.maxDepth ?? base.git.maxDepth,
      maxRepos: file.git?.maxRepos ?? base.git.maxRepos,
      ...(file.git?.ignore === undefined ? {} : { ignore: [...file.git.ignore] }),
    },
    html: {
      scripts: file.html?.scripts ?? base.html.scripts,
    },
  }
}

/** One call: locate + parse + merge. Throws `ConfigError`. */
export function resolveConfig(options: ResolveOptions): { config: EffectiveConfig; origin: ConfigOrigin } {
  const { config, origin } = loadFileConfig(options)
  return { config: mergeConfig(config, options.cli), origin }
}

// --- Writing a `diorama.toml` (contract.md §4.2) ---------------------------

/**
 * The keys a written file may carry, in the order they are emitted: the order
 * of the example in contract.md §4.1, so a written file reads like the docs.
 */
export const CONFIG_KEYS = ['host', 'port', 'plugins', 'ignore', 'watch', 'git', 'html'] as const
export const WATCH_CONFIG_KEYS = ['debounceMs', 'enabled', 'maxDirectories'] as const
export const GIT_CONFIG_KEYS = ['maxDepth', 'maxRepos', 'ignore'] as const
export const HTML_CONFIG_KEYS = ['scripts'] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]
export type WatchConfigKey = (typeof WATCH_CONFIG_KEYS)[number]
export type GitConfigKey = (typeof GIT_CONFIG_KEYS)[number]
export type HtmlConfigKey = (typeof HTML_CONFIG_KEYS)[number]

/**
 * One field to write. `watch.*` is addressed as a dotted key (`watch.enabled`),
 * the same spelling `--dump-config` and the docs use.
 */
export type ConfigPatch = Record<string, unknown>

/** Read one field from a file config (dotted keys address `watch.*`). */
export function readConfigValue(config: FileConfig, key: string): unknown {
  const [head, tail] = key.split('.')
  if (tail !== undefined) {
    if (head !== 'watch' && head !== 'git' && head !== 'html') return undefined
    return (config[head] as Record<string, unknown> | undefined)?.[tail]
  }
  return (config as Record<string, unknown>)[head as string]
}

/**
 * Apply a patch to a file config, leaving every other field alone.
 *
 * `undefined` **deletes** the key: a written file only says what the user
 * chose, so unsetting a field is the way back to the default. The result is
 * validated with the same rules a file read goes through — a CLI value that
 * cannot be written is rejected before anything touches the disk.
 */
export function patchFileConfig(base: FileConfig, patch: ConfigPatch, where = 'config'): FileConfig {
  const next: Record<string, unknown> = { ...base }
  if (next.watch !== undefined) next.watch = { ...(next.watch as Record<string, unknown>) }
  if (next.git !== undefined) next.git = { ...(next.git as Record<string, unknown>) }
  if (next.html !== undefined) next.html = { ...(next.html as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    const [head = '', tail] = key.split('.')
    if (tail !== undefined) {
      const table = head === 'watch'
        ? WATCH_CONFIG_KEYS
        : head === 'git'
          ? GIT_CONFIG_KEYS
          : head === 'html'
            ? HTML_CONFIG_KEYS
            : undefined
      if (table === undefined || !(table as readonly string[]).includes(tail)) {
        throw new ConfigError(`${where}: unknown key "${key}" (known: ${knownKeys().join(', ')})`)
      }
      const nested = { ...((next[head] as Record<string, unknown> | undefined) ?? {}) }
      if (value === undefined) delete nested[tail]
      else nested[tail] = value
      if (Object.keys(nested).length === 0) delete next[head]
      else next[head] = nested
      continue
    }
    if (!(CONFIG_KEYS as readonly string[]).includes(head as string)) {
      throw new ConfigError(`${where}: unknown key "${key}" (known: ${knownKeys().join(', ')})`)
    }
    if (value === undefined) delete next[head as string]
    else next[head as string] = value
  }
  return validateFileConfig(next, where)
}

/** Every addressable key, for messages: `host, port, plugins, ignore, watch.debounceMs, …`. */
export function knownKeys(): string[] {
  return [
    ...CONFIG_KEYS.filter(key => key !== 'watch' && key !== 'git' && key !== 'html'),
    ...WATCH_CONFIG_KEYS.map(key => `watch.${key}`),
    ...GIT_CONFIG_KEYS.map(key => `git.${key}`),
    ...HTML_CONFIG_KEYS.map(key => `html.${key}`),
  ]
}

/**
 * Serialize a file config as TOML, in `CONFIG_KEYS` order. Empty tables are
 * dropped: the file says only what was chosen, and a half-filled `[watch]`
 * table is noise the reader has to explain.
 *
 * Empty **arrays** are kept on purpose: `ignore = []` is the documented way to
 * hide nothing (contract.md §4.1), so dropping it would silently turn "show
 * everything" back into "hide .git and node_modules". A `plugins = []` is
 * likewise an explicit "load no client pieces".
 */
export function formatFileConfig(config: FileConfig): string {
  const table: Record<string, unknown> = {}
  if (config.host !== undefined) table.host = config.host
  if (config.port !== undefined) table.port = config.port
  if (config.plugins !== undefined) table.plugins = [...config.plugins]
  if (config.ignore !== undefined) table.ignore = [...config.ignore]
  const watch: Record<string, unknown> = {}
  for (const key of WATCH_CONFIG_KEYS) {
    const value = config.watch?.[key]
    if (value !== undefined) watch[key] = value
  }
  if (Object.keys(watch).length > 0) table.watch = watch
  const git: Record<string, unknown> = {}
  for (const key of GIT_CONFIG_KEYS) {
    const value = config.git?.[key]
    if (value !== undefined) git[key] = Array.isArray(value) ? [...value] : value
  }
  if (Object.keys(git).length > 0) table.git = git
  const html: Record<string, unknown> = {}
  for (const key of HTML_CONFIG_KEYS) {
    const value = config.html?.[key]
    if (value !== undefined) html[key] = value
  }
  if (Object.keys(html).length > 0) table.html = html
  if (Object.keys(table).length === 0) return ''
  // smol-toml already ends with a newline; a file should not end with a blank line.
  return `${stringifyToml(table).replace(/\n+$/, '')}\n`
}

/** Read a config file as a patchable object; a missing file is an empty config. */
export function readFileConfig(options: {
  path: string
  exists?: (path: string) => boolean
  readFile?: (path: string) => string
}): FileConfig {
  const exists = options.exists ?? existsSync
  if (!exists(options.path)) return {}
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  let text: string
  try {
    text = read(options.path)
  } catch (error) {
    throw new ConfigError(`${options.path}: cannot read (${(error as Error).message})`)
  }
  return parseConfigFile(text, options.path)
}

/**
 * Write a file config. `mkdir -p` on the parent, then an atomic replace: a
 * reader (or a crash) never sees half a file. Injected writers keep this
 * testable without touching a disk.
 */
export function writeFileConfig(options: {
  path: string
  config: FileConfig
  writeFile?: (path: string, text: string) => void
  mkdir?: (path: string) => void
}): { path: string; text: string } {
  const text = formatFileConfig(options.config)
  const dir = dirname(options.path)
  const mkdir = options.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }))
  const write = options.writeFile ?? ((path: string, body: string) => writeFileSync(path, body, 'utf8'))
  try {
    mkdir(dir)
    write(options.path, text)
  } catch (error) {
    throw new ConfigError(`${options.path}: cannot write (${(error as Error).message})`)
  }
  return { path: options.path, text }
}

/**
 * Where a `diorama config` write goes: an explicit `--config` wins; a served
 * directory means *its* `diorama.toml`; otherwise `$DIORAMA_HOME/diorama.toml`.
 * The third case is the default on purpose — browsing a directory never writes
 * into it unless the user names it (architecture.md §8, contract.md §4.2).
 */
export function configWritePath(options: {
  home?: string
  configPath?: string
  root?: string
}): string {
  if (options.configPath !== undefined) return resolve(options.configPath)
  if (options.root !== undefined) return join(resolve(options.root), CONFIG_FILE)
  return join(options.home ?? dioramaHome(), CONFIG_FILE)
}
