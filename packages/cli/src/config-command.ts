/**
 * `diorama config …` (contract.md §4.2): read, edit and interactively build a
 * `diorama.toml`.
 *
 * Two things are deliberately separate:
 *
 * - **Reading** answers "what would `diorama <dir>` use" — the same lookup and
 *   merge as serving (dir file → `$DIORAMA_HOME/diorama.toml` → defaults), so
 *   `show` can never disagree with `--dump-config`.
 * - **Writing** defaults to `$DIORAMA_HOME/diorama.toml`. Browsing a directory
 *   must never write into it (architecture.md §8), so the only ways to write
 *   a project file are naming the directory (`--dir <dir>`) or the file
 *   (`--config <path>`).
 *
 * Every write goes through the kernel's `patchFileConfig` → `validateFileConfig`,
 * i.e. the same rules a hand-written file is held to: a value the reader would
 * reject is rejected before anything touches the disk.
 */
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import {
  ConfigError,
  configWritePath,
  defaultConfig,
  dioramaHome,
  formatFileConfig,
  knownKeys,
  mergeConfig,
  patchFileConfig,
  readConfigValue,
  readFileConfig,
  resolveConfig,
  writeFileConfig,
  type EffectiveConfig,
  type FileConfig,
} from 'diorama-kernel/server'
import { cliName, type CliIo } from './control-client.ts'
import {
  booleanCandidates,
  hostCandidates,
  IGNORE_CANDIDATES,
  isExposed,
  type CandidateSource,
  type InterfaceMap,
} from './config-candidates.ts'
import { createTerminal, type MenuConfig, type Terminal, type TerminalInput } from './config-terminal.ts'

/** A usage problem: printed with the usage block, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

// --- values ---------------------------------------------------------------

const BOOLEANS: Record<string, boolean> = {
  true: true,
  yes: true,
  on: true,
  '1': true,
  false: false,
  no: false,
  off: false,
  '0': false,
}

/** A comma-separated list; the empty string is an explicit empty list. */
export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
}

function parseInteger(key: string, raw: string, min: number, max: number): number {
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`--${key} must be an integer ${min}–${max} (got "${raw}")`)
  }
  return value
}

/**
 * One `--key value` pair as a config value. The key set is the file's own key
 * set (`knownKeys()`): an option that could not be written is a usage error,
 * not a silent no-op.
 */
export function parseConfigValue(key: string, raw: string): unknown {
  switch (key) {
    case 'host': {
      const value = raw.trim()
      if (value === '') throw new UsageError('--host must not be empty')
      return value
    }
    case 'port':
      return parseInteger(key, raw, 0, 65_535)
    case 'plugins':
    case 'ignore':
      return parseList(raw)
    case 'watch.debounceMs':
      return parseInteger(key, raw, 0, 60_000)
    case 'watch.maxDirectories':
      return parseInteger(key, raw, 1, 4096)
    case 'watch.enabled': {
      const value = BOOLEANS[raw.trim().toLowerCase()]
      if (value === undefined) throw new UsageError(`--watch.enabled must be true or false (got "${raw}")`)
      return value
    }
    default:
      throw new UsageError(`unknown key "${key}" (known: ${knownKeys().join(', ')})`)
  }
}

/** How a value is shown in the wizard and in `config show`. */
export function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value === undefined) return '(unset)'
  return String(value)
}

// --- the wizard -----------------------------------------------------------

interface WizardField {
  key: string
  /** Shown after the key in the prompt, e.g. `(0 = a free port)`. */
  hint: string
  /** The value the key falls back to when the file does not set it. */
  fallback: (defaults: EffectiveConfig) => unknown
  /** Parse what the user typed; `UsageError` re-asks instead of aborting. */
  parse: (raw: string) => unknown
  /**
   * A short projection for the prompt. The plugin list is 16 ids long: printing
   * it in full would push the answer off the line, so the prompt shows a count.
   */
  show?: (value: unknown) => string
  /**
   * Fields with a fixed set of sensible values offer them as a numbered menu
   * (contract.md §4.2). Numbers still work as plain text everywhere else:
   * `port` / `debounceMs` / `maxDirectories` take a typed number, no menu.
   */
  menu?: CandidateSource
}

/** What a menu offers, given the value the file currently implies. */
function menuFor(field: WizardField, current: unknown, defaults: EffectiveConfig, interfaces: InterfaceMap): MenuConfig {
  switch (field.menu) {
    case 'host': {
      const value = String(current ?? field.fallback(defaults))
      return {
        title: 'host — where the page listens',
        candidates: hostCandidates(interfaces, value),
        multi: false,
        selected: [value],
        footer: `choose a number, type an address, "-" clears, Enter keeps [${value}]`,
      }
    }
    case 'plugins': {
      const value = (current ?? field.fallback(defaults)) as readonly string[]
      const all = (field.fallback(defaults) as readonly string[]).map(id => ({ value: id }))
      return {
        title: 'plugins — client pieces, in boot order',
        candidates: all,
        multi: true,
        selected: value,
        footer: `toggle by number ("3,7"), "all", "none", Enter keeps [${showList(value)}]`,
      }
    }
    case 'ignore': {
      const value = (current ?? field.fallback(defaults)) as readonly string[]
      // Patterns the file already carries come first, so a custom rule is
      // always visible and can be toggled off like any other.
      const extra = value.filter(pattern => !IGNORE_CANDIDATES.some(candidate => candidate.value === pattern))
      return {
        title: 'ignore — hidden patterns (gitignore syntax)',
        candidates: [...extra.map(pattern => ({ value: pattern, detail: 'in this file' })), ...IGNORE_CANDIDATES],
        multi: true,
        selected: value,
        footer: `toggle by number, type a pattern to add, "none", Enter keeps [${showList(value)}]`,
      }
    }
    case 'boolean': {
      const value = String(current ?? field.fallback(defaults))
      return {
        title: `watch.enabled — ${field.hint}`,
        candidates: booleanCandidates(value === 'true'),
        multi: false,
        selected: [value],
        footer: `choose 1-2, Enter keeps [${value}]`,
      }
    }
    default:
      throw new Error(`field ${field.key} has no menu`)
  }
}

/** `16 plugins` instead of sixteen ids; the full list stays in the file. */
function showList(value: unknown): string {
  const items = Array.isArray(value) ? value : []
  if (items.length === 0) return 'none'
  return `${items.length} ${items.length === 1 ? 'item' : 'items'}`
}

const FIELDS: readonly WizardField[] = [
  {
    key: 'host',
    hint: 'loopback only; widen it on purpose',
    fallback: defaults => defaults.host,
    parse: raw => parseConfigValue('host', raw),
    menu: 'host',
  },
  {
    key: 'port',
    hint: '0 = a free port',
    fallback: defaults => defaults.port,
    parse: raw => parseConfigValue('port', raw),
  },
  {
    key: 'plugins',
    hint: 'comma-separated ids, in boot order',
    fallback: defaults => defaults.plugins,
    parse: raw => parseConfigValue('plugins', raw),
    show: showList,
    menu: 'plugins',
  },
  {
    key: 'ignore',
    hint: 'comma-separated patterns, gitignore syntax',
    fallback: defaults => defaults.ignore,
    parse: raw => parseConfigValue('ignore', raw),
    show: showList,
    menu: 'ignore',
  },
  {
    key: 'watch.enabled',
    hint: 'false = no file watching at all',
    fallback: defaults => defaults.watch.enabled,
    parse: raw => parseConfigValue('watch.enabled', raw),
    menu: 'boolean',
  },
  {
    key: 'watch.debounceMs',
    hint: '0–60000',
    fallback: defaults => defaults.watch.debounceMs,
    parse: raw => parseConfigValue('watch.debounceMs', raw),
  },
  {
    key: 'watch.maxDirectories',
    hint: '1–4096',
    fallback: defaults => defaults.watch.maxDirectories,
    parse: raw => parseConfigValue('watch.maxDirectories', raw),
  },
]

/** One change the wizard made, for the summary printed before writing. */
export interface Change {
  key: string
  /** `undefined` = the field was cleared. */
  value: unknown
  cleared: boolean
}

/** What the wizard asks, given the file being edited. Pure enough to test. */
export async function runWizard(
  file: FileConfig,
  terminal: Pick<Terminal, 'line' | 'select'>,
  options: { defaults?: EffectiveConfig; out: (message: string) => void; interfaces?: InterfaceMap },
): Promise<{ config: FileConfig; changed: boolean; changes: Change[] }> {
  const defaults = options.defaults ?? defaultConfig()
  const interfaces = options.interfaces ?? {}
  let next = file
  const changes: Change[] = []

  const clear = (field: WizardField, current: unknown): void => {
    // `current` is read from the file as it was before this run: clearing a
    // field that is not there would only rewrite the file with nothing new.
    if (current === undefined) {
      options.out(`  ${field.key}: already the default`)
      return
    }
    next = patchFileConfig(next, { [field.key]: undefined }, 'config')
    changes.push({ key: field.key, value: undefined, cleared: true })
  }

  const apply = (field: WizardField, value: unknown): void => {
    next = patchFileConfig(next, { [field.key]: value }, 'config')
    changes.push({ key: field.key, value, cleared: false })
    if (field.key === 'host' && typeof value === 'string' && isExposed(value)) {
      options.out('  ! reachable from other machines on this network')
    }
  }

  for (const field of FIELDS) {
    const current = readConfigValue(file, field.key)
    const fallback = field.fallback(defaults)
    const origin = current === undefined ? 'default' : 'file'

    if (field.menu !== undefined) {
      const menu = menuFor(field, current, defaults, interfaces)
      for (;;) {
        const answer = await terminal.select(menu)
        if (answer === undefined) throw new UsageError('input ended before the wizard finished')
        if (answer.kind === 'keep' || answer.kind === 'eof') break
        const text = answer.kind === 'free' ? answer.text : answer.values.join(',')
        const trimmed = text.trim()
        if (trimmed === '') break
        if (trimmed === '-') {
          clear(field, current)
          break
        }
        // The two whole-list words the menu advertises (multi-select only).
        if (menu.multi && (trimmed.toLowerCase() === 'all' || trimmed.toLowerCase() === 'none')) {
          apply(field, trimmed.toLowerCase() === 'all' ? menu.candidates.map(candidate => candidate.value) : [])
          break
        }
        try {
          apply(field, field.parse(trimmed))
          break
        } catch (failure) {
          if (!(failure instanceof UsageError) && !(failure instanceof ConfigError)) throw failure
          options.out(`  ! ${failure.message}`)
        }
      }
      continue
    }

    // A plain field: one line, the value read as typed (numbers are numbers).
    const shown = (field.show ?? displayValue)(current ?? fallback)
    for (;;) {
      const answer = await terminal.line(`  ${field.key} [${shown}] (${origin}, ${field.hint}): `)
      if (answer === undefined) throw new UsageError('input ended before the wizard finished')
      const trimmed = answer.trim()
      if (trimmed === '') break
      if (trimmed === '-') {
        clear(field, current)
        break
      }
      try {
        apply(field, field.parse(trimmed))
        break
      } catch (failure) {
        if (!(failure instanceof UsageError) && !(failure instanceof ConfigError)) throw failure
        options.out(`  ! ${failure.message}`)
      }
    }
  }
  return { config: next, changed: changes.length > 0, changes }
}

/** `host: 127.0.0.1 → 0.0.0.0`, `ignore: +dist -*.log`, one line per field. */
export function summarizeChanges(changes: readonly Change[], before: FileConfig | EffectiveConfig): string[] {
  return changes.map(change => {
    const previous = readConfigValue(before, change.key)
    if (change.cleared) return `${change.key}: cleared (was ${displayValue(previous)})`
    const next = change.value
    if (Array.isArray(next)) {
      const value: unknown[] = next
      const beforeItems: unknown[] = Array.isArray(previous) ? previous : []
      const added = value.filter(item => !beforeItems.includes(item))
      const removed = beforeItems.filter(item => !value.includes(item))
      if (value.length === 0) return `${change.key}: empty`
      if (added.length === 0 && removed.length === 0) return `${change.key}: (unchanged)`
      const parts = [...added.map(item => `+${String(item)}`), ...removed.map(item => `-${String(item)}`)]
      return `${change.key}: ${parts.join(' ')}`
    }
    // A field the file did not mention has no "before": say what it becomes.
    if (previous === undefined) return `${change.key}: set to ${displayValue(next)}`
    return `${change.key}: ${displayValue(previous)} → ${displayValue(next)}`
  })
}

// --- the command ----------------------------------------------------------

interface ConfigArgs {
  /** `--config <path>`: the file itself. */
  config?: string
  /** `--dir <dir>`: write/read `<dir>/diorama.toml`. */
  dir?: string
  /** `--dry-run`: print, do not write. */
  dryRun: boolean
  /** `--yes`: accept the values as shown (no confirmation, no prompts). */
  yes: boolean
  /** `--json`: `config show` only. */
  json: boolean
  /** `--all`: `config set` only — the same thing as `--ignore ""`. */
  all: boolean
  /** Positional arguments: keys for `unset`, nothing elsewhere. */
  positional: string[]
  /** `--<key> <value>` pairs collected for `set`. */
  pairs: [string, string][]
}

const VALUE_KEYS = new Set(knownKeys())

/**
 * Which options each verb accepts. A flag that would silently do nothing is a
 * usage error instead: `config show --dry-run` reading like "show me without
 * writing" and then doing nothing is exactly the kind of quiet surprise the
 * config file itself is not allowed to have.
 */
const VERB_FLAGS: Record<string, readonly string[]> = {
  edit: ['--config', '--dir', '--dry-run', '--yes'],
  show: ['--config', '--dir', '--json'],
  set: ['--config', '--dir', '--dry-run', '--all'],
  unset: ['--config', '--dir', '--dry-run'],
}

function parseConfigArgs(argv: readonly string[], verb: string): ConfigArgs {
  const allowed = VERB_FLAGS[verb] ?? []
  const args: ConfigArgs = { dryRun: false, yes: false, json: false, all: false, positional: [], pairs: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (arg === '--config' || arg === '--dir') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      index++
      if (arg === '--config') args.config = value
      else args.dir = value
      continue
    }
    if (arg === '--dry-run' || arg === '--yes' || arg === '-y' || arg === '--json' || arg === '--all') {
      const flag = arg === '-y' ? '--yes' : arg
      if (!allowed.includes(flag)) {
        throw new UsageError(`"${arg}" does not apply to config ${verb} (accepted: ${allowed.join(', ') || '(none)'})`)
      }
      if (flag === '--dry-run') args.dryRun = true
      else if (flag === '--yes') args.yes = true
      else if (flag === '--json') args.json = true
      else args.all = true
      continue
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (verb !== 'set' || !VALUE_KEYS.has(key)) {
        throw new UsageError(
          `unknown option "${arg}" for config ${verb} (accepted: ${allowed.join(', ') || '(none)'}${verb === 'set' ? ', --<key> <value>' : ''})`,
        )
      }
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`)
      index++
      args.pairs.push([key, value])
      continue
    }
    if (arg.startsWith('-')) throw new UsageError(`unknown option "${arg}" for config ${verb}`)
    args.positional.push(arg)
  }
  return args
}

/** The directory `--dir` names, realpath'd (the same rule serving uses). */
async function realDirectory(input: string): Promise<string> {
  const { realpath, stat } = await import('node:fs/promises')
  let root: string
  try {
    root = await realpath(resolve(input))
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new UsageError(`cannot use "${input}": not a readable directory`)
  }
  return root
}

/** Where this invocation writes, and whether that directory is a project. */
async function writeTarget(args: ConfigArgs, io: CliIo): Promise<{ path: string; root?: string }> {
  const root = args.dir === undefined ? undefined : await realDirectory(args.dir)
  const path = configWritePath({
    home: dioramaHome(io.env),
    ...(args.config === undefined ? {} : { configPath: args.config }),
    ...(root === undefined ? {} : { root }),
  })
  return { path, ...(root === undefined ? {} : { root }) }
}

/**
 * `diorama config [--dir <dir> | --config <path>]`: the interactive editor.
 * `options` injects the stdin stream and the interface list (tests).
 */
export async function wizard(
  io: CliIo,
  args: ConfigArgs,
  options: { stdin?: TerminalInput; interfaces?: InterfaceMap } = {},
): Promise<number> {
  if (args.positional.length > 0) {
    throw new UsageError(`unexpected argument "${args.positional[0]}" (use --dir <dir> to edit <dir>/diorama.toml)`)
  }
  const { path } = await writeTarget(args, io)
  const file = readFileConfig({ path })
  io.out(`editing ${path}`)
  const existing = formatFileConfig(file)
  if (existing !== '') io.out(existing.replace(/\n$/, ''))
  io.out('Enter keeps a value, "-" clears it.')

  // The terminal writes bytes, not lines: escape sequences and frames must land
  // exactly where they are meant to, so this sink never adds a newline.
  const terminal = createTerminal(options.stdin ?? process.stdin, text => io.raw(text))
  let result: { config: FileConfig; changed: boolean; changes: Change[] }
  try {
    result = await runWizard(file, terminal, {
      out: message => io.out(message),
      // The machine's own addresses: the whole point of the `host` menu.
      interfaces: options.interfaces ?? (networkInterfaces() as InterfaceMap),
    })
    if (!result.changed) {
      io.out('no changes')
      return 0
    }
    const text = formatFileConfig(result.config)
    io.out('')
    io.out('changes:')
    // Summarize against what the reader sees today (defaults ← file), not
    // against the file alone: "ignore: +dist" beats "set to 16 patterns".
    const before = mergeConfig(file)
    for (const line of summarizeChanges(result.changes, before)) io.out(`  ${line}`)
    io.out('')
    io.out(text === '' ? '(the file will be empty: every setting is back to its default)' : text.replace(/\n$/, ''))
    if (args.dryRun) {
      io.out(`dry run: not writing ${path}`)
      return 0
    }
    if (!args.yes) {
      const answer = await terminal.line('write this file? [Y/n] ')
      if (answer === undefined) throw new UsageError('input ended before the confirmation')
      if (!/^(y|yes)?$/i.test(answer.trim())) {
        io.out(`not written: ${path}`)
        return 0
      }
    }
  } finally {
    terminal.close()
  }
  writeFileConfig({ path, config: result.config })
  io.out(`wrote ${path}`)
  return 0
}

/** `diorama config show`: what `diorama <dir>` would use. */
async function show(io: CliIo, args: ConfigArgs): Promise<number> {
  const dir = args.positional[0] ?? args.dir ?? '.'
  if (args.positional.length > 1) throw new UsageError(`unexpected argument "${args.positional[1]}"`)
  let root: string
  try {
    root = await realDirectory(dir)
  } catch {
    throw new UsageError(`cannot serve "${dir}": not a readable directory`)
  }
  const resolved = resolveConfig({
    root,
    home: dioramaHome(io.env),
    ...(args.config === undefined ? {} : { configPath: args.config }),
  })
  if (args.json) {
    io.out(JSON.stringify({ config: resolved.config, configFile: resolved.origin.path ?? null }, null, 2))
    return 0
  }
  io.out(`config file: ${resolved.origin.path ?? 'none (defaults)'}`)
  for (const [key, value] of Object.entries(resolved.config)) {
    if (key === 'watch') {
      for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
        io.out(`  watch.${name} = ${displayValue(inner)}`)
      }
      continue
    }
    io.out(`  ${key} = ${displayValue(value)}`)
  }
  return 0
}

/** `diorama config set --<key> <value> …`. */
async function set(io: CliIo, args: ConfigArgs): Promise<number> {
  if (args.positional.length > 0) {
    throw new UsageError(`unexpected argument "${args.positional[0]}" (use --dir <dir> to edit <dir>/diorama.toml)`)
  }
  const patch: Record<string, unknown> = {}
  for (const [key, raw] of args.pairs) patch[key] = parseConfigValue(key, raw)
  if (args.all) patch.ignore = []
  if (Object.keys(patch).length === 0) {
    throw new UsageError('nothing to set; give at least one --<key> <value> (see "config show" for the keys)')
  }
  const { path } = await writeTarget(args, io)
  const next = patchFileConfig(readFileConfig({ path }), patch, path)
  return write(io, args, path, next)
}

/** `diorama config unset <key> …`: back to the default. */
async function unset(io: CliIo, args: ConfigArgs): Promise<number> {
  if (args.positional.length === 0) throw new UsageError(`nothing to unset (keys: ${knownKeys().join(', ')})`)
  const patch: Record<string, unknown> = {}
  for (const key of args.positional) patch[key] = undefined
  const { path } = await writeTarget(args, io)
  const next = patchFileConfig(readFileConfig({ path }), patch, path)
  return write(io, args, path, next)
}

function write(io: CliIo, args: ConfigArgs, path: string, config: FileConfig): number {
  const text = formatFileConfig(config)
  if (args.dryRun) {
    io.out(text === '' ? '(the file would be empty)' : text.replace(/\n$/, ''))
    io.out(`dry run: not writing ${path}`)
    return 0
  }
  writeFileConfig({ path, config })
  io.out(text === '' ? `wrote ${path} (no settings left: everything is default)` : `wrote ${path}`)
  return 0
}

/** `diorama config …`: dispatch on the verb. */
export async function configCommand(
  io: CliIo,
  argv: readonly string[],
  options: { stdin?: TerminalInput; interfaces?: InterfaceMap } = {},
): Promise<number> {
  const [verb, ...rest] = argv
  // `diorama config --dir <dir>` (no verb) is the wizard: options may come
  // before the word "show"/"set"/"unset" would.
  const head = verb === undefined || verb.startsWith('-') ? undefined : verb
  const wizardArgs = head === undefined ? argv : rest
  try {
    switch (head) {
      case undefined:
        return await wizard(io, parseConfigArgs(wizardArgs, 'edit'), options)
      case 'show':
        return await show(io, parseConfigArgs(rest, 'show'))
      case 'set':
        return await set(io, parseConfigArgs(rest, 'set'))
      case 'unset':
        return await unset(io, parseConfigArgs(rest, 'unset'))
      case '--help':
      case '-h':
        io.out(configUsage(cliName(io)))
        return 0
      default:
        io.err(`${cliName(io)}: unknown config command "${verb}"\n\n${configUsage(cliName(io))}`)
        return 2
    }
  } catch (failure) {
    if (failure instanceof UsageError) {
      io.err(`${cliName(io)}: ${failure.message}\n\n${configUsage(cliName(io))}`)
      return 2
    }
    if (failure instanceof ConfigError) {
      io.err(`${cliName(io)}: ${failure.message}`)
      return 2
    }
    throw failure
  }
}

export function configUsage(name = 'diorama'): string {
  return `Usage:
  ${name} config [--dir <dir> | --config <path>] [--yes] [--dry-run]
                                 edit a diorama.toml in a terminal, field by field
  ${name} config show [<dir>] [--config <path>] [--json]
                                 the configuration "diorama <dir>" would use
  ${name} config set [--dir <dir> | --config <path>] --<key> <value> …
                                 write fields, leaving the rest of the file alone
  ${name} config unset [--dir <dir> | --config <path>] <key> …
                                 drop fields (back to the default)

Keys for set/unset:
  host                    --host 0.0.0.0
  port                    --port 8080          (0 = a free port)
  plugins                 --plugins slots,layout
  ignore                  --ignore ".git,*.log" (empty = hide nothing; --all is the same)
  watch.enabled           --watch.enabled false
  watch.debounceMs        --watch.debounceMs 300
  watch.maxDirectories    --watch.maxDirectories 64

Where it writes:
  no --dir/--config       $DIORAMA_HOME/diorama.toml (the global default)
  --dir <dir>             <dir>/diorama.toml
  --config <path>         exactly that file

Environment:
  DIORAMA_HOME            state directory (default ~/.diorama)
`
}
