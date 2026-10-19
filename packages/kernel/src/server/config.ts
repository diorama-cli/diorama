/**
 * Effective configuration (contract.md §4.1): `diorama.toml` + CLI + defaults,
 * merged once, here.
 *
 * Precedence is **CLI > diorama.toml > default**. The CLI therefore carries
 * `undefined` for "not given" (see `parseArgs`) — a CLI default would shadow
 * every toml value silently. Errors are fail loud: a syntax error, an unknown
 * key, or a wrong type prints the file and the reason and the CLI exits 2.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { DEFAULT_IGNORE } from '../shared/ignore.ts'
import { BUILTIN_PLUGIN_IDS } from './plan.ts'

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
}

/** What a `diorama.toml` may say (every field optional). */
export interface FileConfig {
  host?: string
  port?: number
  plugins?: string[]
  ignore?: string[]
  watch?: { debounceMs?: number; enabled?: boolean; maxDirectories?: number }
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
  }
}

/** `$DIORAMA_HOME` or `~/.diorama`. */
export function dioramaHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DIORAMA_HOME
  return home !== undefined && home !== '' ? resolve(home) : join(homedir(), '.diorama')
}

const ROOT_KEYS = new Set(['host', 'port', 'plugins', 'ignore', 'watch'])
const WATCH_KEYS = new Set(['debounceMs', 'enabled', 'maxDirectories'])

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
  }
}

/** One call: locate + parse + merge. Throws `ConfigError`. */
export function resolveConfig(options: ResolveOptions): { config: EffectiveConfig; origin: ConfigOrigin } {
  const { config, origin } = loadFileConfig(options)
  return { config: mergeConfig(config, options.cli), origin }
}
