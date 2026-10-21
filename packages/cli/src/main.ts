/**
 * CLI entry: `diorama [dir] [options]`, `diorama ls`, `diorama gateway …`,
 * `diorama restart <mount>` (contract.md §7.5–§7.6).
 *
 * `diorama <dir>` is short-lived: ensure the gateway runs, ask it to mount the
 * directory, print the URL, exit. `--foreground` runs the gateway in this
 * process instead (the debug/test form).
 */
import { resolve } from 'node:path'
import {
  ConfigError,
  dioramaHome,
  resolveConfig,
  type EffectiveConfig,
  type MountStatus,
} from 'diorama-kernel/server'
import {
  controlCall,
  cliName,
  defaultIo,
  gatewayLogPath,
  listMounts,
  restartGateway,
  startGateway,
  stopGateway,
  type CliIo,
} from './control-client.ts'
import { configCommand } from './config-command.ts'
import { runGateway, socketPath } from './gateway-command.ts'
import { mountDocument, mountLines, type MountOutput } from './mount-output.ts'
import { main as serveMain, parseArgs, USAGE, usage } from './run.ts'

export { USAGE, parseArgs, usage }

/** The control-plane usage block, named after the invoked command. */
export function controlUsage(name = 'diorama'): string {
  return `Usage:
  ${name} [dir] [options]        mount a directory (starts the gateway if needed)
  ${name} ls [--json]            list mounts: directory, URL, status
  ${name} restart <mount|dir>    unmount and mount again (--json for scripts)
  ${name} config [show|set|unset]  read or edit a diorama.toml (see "${name} config --help")
  ${name} gateway start|stop|status|restart
  ${name} gateway run            run the gateway in the foreground
  ${name} --version              print the version (from this package's manifest)

Options for "${name} [dir]":
  --foreground                   run the gateway in this process (no daemon)
  --json                         print the mount as one JSON document (for scripts)
  --port / --host / --plugins / --config / --all / --break-plugin
  --dump-plan / --dump-config    print the resolved plan/configuration and exit

Environment:
  DIORAMA_HOME                   state directory (default ~/.diorama)
`
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // The beta entry sets DIORAMA_CHANNEL=beta; its messages must name it too.
  const name = env.DIORAMA_CHANNEL === 'beta' ? 'diorama-beta' : 'diorama'
  const io: CliIo = { ...defaultIo(), env, name }
  const [command, ...rest] = argv

  if (command === 'ls') {
    const unknown = rest.find(arg => arg !== '--json')
    if (unknown !== undefined) {
      io.err(`${cliName(io)}: unknown option "${unknown}" for ls\n\n${controlUsage(cliName(io))}`)
      return 2
    }
    return listMounts(io, { json: rest.includes('--json') })
  }

  if (command === 'restart') return restartMount(io, rest)
  if (command === 'config') return configCommand(io, rest)
  if (command === 'gateway') return gatewayCommand(io, rest)

  if (command === '--help' || command === '-h') {
    io.out(usage(cliName(io)))
    return 0
  }

  if (command === 'help') {
    io.out(controlUsage(cliName(io)))
    return 0
  }

  // `--version` / `-v`: the number the package was published with. The bin
  // entries put it in `DIORAMA_VERSION` (read from `package.json`), so this
  // never drifts from what npm installed (docs/m8/spec.md §1).
  if (command === '--version' || command === '-v') {
    io.out(env.DIORAMA_VERSION ?? '0.0.0-dev')
    return 0
  }

  if (argv.includes('--foreground')) {
    return foreground(io, argv.filter(arg => arg !== '--foreground'))
  }

  return mountCommand(io, argv)
}

/** `diorama gateway …` (contract.md §7.4). */
async function gatewayCommand(io: CliIo, argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv
  const force = rest.includes('--force')
  const unknown = rest.find(arg => arg !== '--force')
  if (unknown !== undefined) {
    io.err(`${cliName(io)}: unknown option "${unknown}" for gateway\n\n${controlUsage(cliName(io))}`)
    return 2
  }
  try {
    switch (verb) {
      case 'run': {
        await runGateway({ env: io.env, log: message => io.err(message) })
        // Keep this process alive until a `stop` closes the gateway.
        return new Promise<number>(() => {})
      }
      case 'start': {
        const { started, status } = await startGateway(io)
        io.out(started ? `gateway started (pid ${status?.pid ?? '?'})` : `gateway already running (pid ${status?.pid ?? '?'})`)
        io.out(`  socket: ${socketPath(io.env)}`)
        io.out(`  log:    ${gatewayLogPath(io.env)}`)
        return 0
      }
      case 'stop': {
        const { stopped } = await stopGateway(io, force)
        io.out(stopped ? 'gateway stopped' : 'gateway is not running')
        return 0
      }
      case 'status': {
        const status = (await controlCall(io, 'status')) as {
          pid: number
          state: string
          mounts: MountStatus[]
        }
        io.out(`gateway running (pid ${status.pid})${status.state === 'degraded' ? ' — degraded' : ''}`)
        io.out(`  socket: ${socketPath(io.env)}`)
        io.out(`  mounts: ${status.mounts.length}`)
        for (const mount of status.mounts) {
          io.out(`  [${mount.mountId}] ${mount.state} ${mount.url} ${mount.root}`)
        }
        return 0
      }
      case 'restart': {
        await restartGateway(io)
        io.out(`gateway restarted (mounts are not preserved; run "${cliName(io)} <dir>" again)`)
        return 0
      }
      default:
        io.err(controlUsage(cliName(io)))
        return 2
    }
  } catch (failure) {
    return reportFailure(io, failure)
  }
}

/** `diorama restart <mountId|dir>` (contract.md §11.1: manual recovery). */
export async function restartMount(io: CliIo, argv: readonly string[]): Promise<number> {
  const target = argv.find(arg => !arg.startsWith('--'))
  if (target === undefined) {
    io.err(`${cliName(io)}: restart needs a mount id or a directory\n\n${controlUsage(cliName(io))}`)
    return 2
  }
  const root = resolve(target)
  try {
    // The configuration is the CLI's job (contract.md §4.1): re-resolve it for
    // this directory, exactly like a fresh `diorama <dir>`.
    const real = await realDirectory(root)
    const merged = resolveConfig({ root: real, home: dioramaHome(io.env) })
    const removed = (await controlCall(io, 'unmount', { root: real }).catch(() => ({ mountId: '', root: real }))) as {
      mountId: string
      root: string
    }
    const mounted = (await controlCall(io, 'mount', {
      root: real,
      config: merged.config,
      ...(merged.origin.path === undefined ? {} : { configFile: merged.origin.path }),
    })) as MountStatus & { created: boolean }
    if (argv.includes('--json')) {
      io.out(JSON.stringify({ ...mountDocument({ mount: mounted, created: true }), remounted: removed.mountId || null }))
      return 0
    }
    io.out(`diorama serving ${mounted.root}`)
    io.out(`  ${mounted.url}`)
    io.out(`  remounted ${removed.mountId || '(none)'} → ${mounted.mountId}`)
    return 0
  } catch (failure) {
    return reportFailure(io, failure)
  }
}

/** `diorama [dir]`: merge config here, then let the gateway mount it. */
async function mountCommand(io: CliIo, argv: readonly string[]): Promise<number> {
  const { options, error } = parseArgs(argv)
  if (error === 'help') {
    io.out(usage(cliName(io)))
    return 0
  }
  if (error !== undefined) {
    io.err(`${cliName(io)}: ${error}\n\n${usage(cliName(io))}`)
    return 2
  }
  // `--dump-config` / `--dump-plan` describe configuration and boot graph
  // without serving anything: they are the M1/M2 CLI's own paths.
  if (options.dumpConfig || options.dumpPlan) return (await serveMain(argv)) ?? 0

  let root: string
  try {
    root = await realDirectory(options.dir)
  } catch {
    io.err(`${cliName(io)}: cannot serve "${options.dir}": not a readable directory`)
    return 2
  }
  let config: EffectiveConfig
  let configFile: string | undefined
  try {
    const resolved = resolveConfig({
      root,
      home: dioramaHome(io.env),
      ...(options.config === undefined ? {} : { configPath: options.config }),
      cli: {
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
        all: options.all,
      },
    })
    config = resolved.config
    configFile = resolved.origin.path
  } catch (failure) {
    if (!(failure instanceof ConfigError)) throw failure
    io.err(`${cliName(io)}: ${failure.message}`)
    return 2
  }

  try {
    // The gateway is a machine-wide singleton: start it when it is not there.
    await startGateway(io)
    const mounted = (await controlCall(io, 'mount', {
      root,
      config,
      ...(configFile === undefined ? {} : { configFile }),
      ...(options.breakPlugin === undefined ? {} : { breakPlugin: options.breakPlugin }),
    })) as MountStatus & { created: boolean; pluginFailures?: string }
    printMount(io, { mount: mounted, created: mounted.created, ...(mounted.pluginFailures === undefined ? {} : { pluginFailures: mounted.pluginFailures }) }, { json: options.json })
    if (mounted.pluginFailures !== undefined) {
      io.err(`${cliName(io)}: ${mounted.pluginFailures}`)
      return 1
    }
    return 0
  } catch (failure) {
    return reportFailure(io, failure)
  }
}

/** `--foreground`: the gateway runs in this process and mounts one directory. */
async function foreground(io: CliIo, argv: readonly string[]): Promise<number> {
  const { options, error } = parseArgs(argv)
  if (error === 'help') {
    io.out(usage(cliName(io)))
    return 0
  }
  if (error !== undefined) {
    io.err(`${cliName(io)}: ${error}\n\n${usage(cliName(io))}`)
    return 2
  }
  let root: string
  try {
    root = await realDirectory(options.dir)
  } catch {
    io.err(`${cliName(io)}: cannot serve "${options.dir}": not a readable directory`)
    return 2
  }
  let config: EffectiveConfig
  let configFile: string | undefined
  try {
    const resolved = resolveConfig({
      root,
      home: dioramaHome(io.env),
      ...(options.config === undefined ? {} : { configPath: options.config }),
      cli: {
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
        all: options.all,
      },
    })
    config = resolved.config
    configFile = resolved.origin.path
  } catch (failure) {
    if (!(failure instanceof ConfigError)) throw failure
    io.err(`${cliName(io)}: ${failure.message}`)
    return 2
  }
  let gateway: Awaited<ReturnType<typeof runGateway>>
  try {
    gateway = await runGateway({ env: io.env, log: message => io.err(message) })
  } catch (failure) {
    return reportFailure(io, failure)
  }
  try {
    // Mount through the socket the gateway just bound: the same path a
    // short-lived CLI takes, so foreground and daemon behave identically.
    const mounted = (await controlCall(io, 'mount', {
      root,
      config,
      ...(configFile === undefined ? {} : { configFile }),
      ...(options.breakPlugin === undefined ? {} : { breakPlugin: options.breakPlugin }),
    })) as MountStatus & { created: boolean; pluginFailures?: string }
    printMount(
      io,
      { mount: mounted, created: mounted.created, ...(mounted.pluginFailures === undefined ? {} : { pluginFailures: mounted.pluginFailures }) },
      { json: options.json },
    )
    if (mounted.pluginFailures !== undefined) io.err(`${cliName(io)}: ${mounted.pluginFailures}`)
  } catch (failure) {
    await gateway.close()
    return reportFailure(io, failure)
  }
  const shutdown = (): void => {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    void gateway.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return new Promise<number>(() => {})
}

/**
 * Print the mount: the five lines (contract.md §7.6), or **one** JSON document
 * with `--json` so another program can read the URL without parsing prose.
 *
 * Everything goes to stdout in both forms: stdout carries the answer, stderr
 * carries failures (`pluginFailures` is both a JSON field and a stderr line).
 */
function printMount(io: CliIo, output: MountOutput, options: { json?: boolean } = {}): void {
  if (options.json) {
    io.out(JSON.stringify(mountDocument(output)))
    return
  }
  for (const line of mountLines(output, cliName(io))) io.out(line)
}

/** The directory behind a user-supplied path (realpath'd, must be a directory). */
async function realDirectory(input: string): Promise<string> {
  const { realpath, stat } = await import('node:fs/promises')
  const root = await realpath(resolve(input))
  if (!(await stat(root)).isDirectory()) throw new Error('not a directory')
  return root
}

/** Map a failure to the contract's exit codes (contract.md §7.6). */
function reportFailure(io: CliIo, failure: unknown): number {
  const code = (failure as { code?: string }).code
  const message = failure instanceof Error ? failure.message : String(failure)
  const clean = code !== undefined && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message
  switch (code) {
    case 'EADDRINUSE':
    case 'ENOMOUNT':
    case 'ESTARTING':
      io.err(`${cliName(io)}: ${clean}`)
      return 1
    case 'ENOTDIR':
      io.err(`${cliName(io)}: ${clean}`)
      return 2
    case 'EGATEWAYDEAD':
      io.err(`${cliName(io)}: the gateway is not running (run "${cliName(io)} gateway start")`)
      return 1
    default:
      io.err(`${cliName(io)}: ${message}`)
      return 1
  }
}
