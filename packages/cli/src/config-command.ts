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
import { resolve } from 'node:path'
import {
  ConfigError,
  configWritePath,
  defaultConfig,
  dioramaHome,
  formatFileConfig,
  knownKeys,
  patchFileConfig,
  readConfigValue,
  readFileConfig,
  resolveConfig,
  writeFileConfig,
  type EffectiveConfig,
  type FileConfig,
} from 'diorama-kernel/server'
import { cliName, type CliIo } from './control-client.ts'

/** A usage problem: printed with the usage block, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** One answer from the terminal. `undefined` = stdin ended. */
export interface Prompter {
  ask(question: string): Promise<string | undefined>
  close(): void
}

/**
 * A line reader over a stream. Written by hand instead of `readline/promises`
 * so that "stdin ended" is a value rather than a promise that never settles:
 * `diorama config < /dev/null` must fail loudly, not hang.
 */
export function streamPrompter(input: NodeJS.ReadableStream, write: (text: string) => void): Prompter {
  let buffer = ''
  const pending: string[] = []
  const waiters: ((line: string | undefined) => void)[] = []
  let ended = false

  const deliver = (): void => {
    while (waiters.length > 0 && (pending.length > 0 || ended)) {
      const settle = waiters.shift() as (line: string | undefined) => void
      settle(pending.shift())
    }
  }
  input.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      pending.push(buffer.slice(0, index).replace(/\r$/, ''))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
    deliver()
  })
  input.on('end', () => {
    if (buffer !== '') {
      pending.push(buffer)
      buffer = ''
    }
    ended = true
    deliver()
  })
  input.on('close', () => {
    ended = true
    deliver()
  })
  return {
    async ask(question) {
      write(question)
      return await new Promise<string | undefined>((settle) => {
        waiters.push(settle)
        deliver()
      })
    },
    close() {
      input.removeAllListeners('data')
    },
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
  },
  {
    key: 'ignore',
    hint: 'comma-separated patterns, gitignore syntax',
    fallback: defaults => defaults.ignore,
    parse: raw => parseConfigValue('ignore', raw),
    show: showList,
  },
  {
    key: 'watch.enabled',
    hint: 'false = no file watching at all',
    fallback: defaults => defaults.watch.enabled,
    parse: raw => parseConfigValue('watch.enabled', raw),
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

/** What the wizard asks, given the file being edited. Pure enough to test. */
export async function runWizard(
  file: FileConfig,
  ask: (question: string) => Promise<string | undefined>,
  options: { defaults?: EffectiveConfig; out: (message: string) => void },
): Promise<{ config: FileConfig; changed: boolean }> {
  const defaults = options.defaults ?? defaultConfig()
  let next = file
  let changed = false
  for (const field of FIELDS) {
    const current = readConfigValue(file, field.key)
    const fallback = field.fallback(defaults)
    const shown = (field.show ?? displayValue)(current ?? fallback)
    const origin = current === undefined ? 'default' : 'file'
    for (;;) {
      const answer = await ask(`  ${field.key} [${shown}] (${origin}, ${field.hint}): `)
      if (answer === undefined) throw new UsageError('input ended before the wizard finished')
      const trimmed = answer.trim()
      if (trimmed === '') break
      if (trimmed === '-') {
        // `current` is read from the file as it was before this run: clearing a
        // field that is not there would only rewrite the file with nothing new.
        if (current === undefined) {
          options.out(`  ${field.key}: already the default`)
          break
        }
        next = patchFileConfig(next, { [field.key]: undefined }, 'config')
        changed = true
        options.out(`  ${field.key}: cleared (back to the default)`)
        break
      }
      try {
        const value = field.parse(trimmed)
        next = patchFileConfig(next, { [field.key]: value }, 'config')
        changed = true
        break
      } catch (failure) {
        if (!(failure instanceof UsageError) && !(failure instanceof ConfigError)) throw failure
        options.out(`  ! ${failure.message}`)
      }
    }
  }
  return { config: next, changed }
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

/** `diorama config [--dir <dir> | --config <path>]`: the interactive editor. */
async function wizard(io: CliIo, args: ConfigArgs): Promise<number> {
  if (args.positional.length > 0) {
    throw new UsageError(`unexpected argument "${args.positional[0]}" (use --dir <dir> to edit <dir>/diorama.toml)`)
  }
  const { path } = await writeTarget(args, io)
  const file = readFileConfig({ path })
  io.out(`editing ${path}`)
  const existing = formatFileConfig(file)
  if (existing !== '') io.out(existing.replace(/\n$/, ''))
  io.out('Enter keeps a value, "-" clears it.')

  const prompter = streamPrompter(process.stdin, text => io.out(text.trimEnd()))
  let result: { config: FileConfig; changed: boolean }
  try {
    result = await runWizard(file, question => prompter.ask(question), { out: message => io.out(message) })
    if (!result.changed) {
      io.out('no changes')
      return 0
    }
    const text = formatFileConfig(result.config)
    io.out('')
    io.out(text === '' ? '(the file will be empty: every setting is back to its default)' : text.replace(/\n$/, ''))
    if (args.dryRun) {
      io.out(`dry run: not writing ${path}`)
      return 0
    }
    if (!args.yes) {
      const answer = await prompter.ask('write this file? [Y/n] ')
      if (answer === undefined) throw new UsageError('input ended before the confirmation')
      if (!/^(y|yes)?$/i.test(answer.trim())) {
        io.out(`not written: ${path}`)
        return 0
      }
    }
  } finally {
    prompter.close()
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
export async function configCommand(io: CliIo, argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv
  // `diorama config --dir <dir>` (no verb) is the wizard: options may come
  // before the word "show"/"set"/"unset" would.
  const head = verb === undefined || verb.startsWith('-') ? undefined : verb
  const wizardArgs = head === undefined ? argv : rest
  try {
    switch (head) {
      case undefined:
        return await wizard(io, parseConfigArgs(wizardArgs, 'edit'))
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
