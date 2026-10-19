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
  defaultIo,
  gatewayLogPath,
  listMounts,
  restartGateway,
  startGateway,
  stopGateway,
  type CliIo,
} from './control-client.ts'
import { runGateway, socketPath } from './gateway-command.ts'
import { main as serveMain, parseArgs, USAGE } from './run.ts'

export { USAGE, parseArgs }

export const CONTROL_USAGE = `Usage:
  diorama [dir] [options]        mount a directory (starts the gateway if needed)
  diorama ls [--json]            list mounts: directory, URL, status
  diorama restart <mount|dir>    unmount and mount again
  diorama gateway start|stop|status|restart
  diorama gateway run            run the gateway in the foreground

Options for "diorama [dir]":
  --foreground                   run the gateway in this process (no daemon)
  --port / --host / --plugins / --config / --all / --break-plugin
  --dump-plan / --dump-config    print the resolved plan/configuration and exit

Environment:
  DIORAMA_HOME                   state directory (default ~/.diorama)
`

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const io: CliIo = { ...defaultIo(), env }
  const [command, ...rest] = argv

  if (command === 'ls') {
    const unknown = rest.find(arg => arg !== '--json')
    if (unknown !== undefined) {
      io.err(`diorama: unknown option "${unknown}" for ls\n\n${CONTROL_USAGE}`)
      return 2
    }
    return listMounts(io, { json: rest.includes('--json') })
  }

  if (command === 'restart') return restartMount(io, rest)
  if (command === 'gateway') return gatewayCommand(io, rest)

  if (command === '--help' || command === '-h') {
    io.out(USAGE)
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
    io.err(`diorama: unknown option "${unknown}" for gateway\n\n${CONTROL_USAGE}`)
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
        io.out('gateway restarted (mounts are not preserved; run "diorama <dir>" again)')
        return 0
      }
      default:
        io.err(CONTROL_USAGE)
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
    io.err(`diorama: restart needs a mount id or a directory\n\n${CONTROL_USAGE}`)
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
    io.out(USAGE)
    return 0
  }
  if (error !== undefined) {
    io.err(`diorama: ${error}\n\n${USAGE}`)
    return 2
  }
  // `--dump-config` / `--dump-plan` describe configuration and boot graph
  // without serving anything: they are the M1/M2 CLI's own paths.
  if (options.dumpConfig || options.dumpPlan) return (await serveMain(argv)) ?? 0

  let root: string
  try {
    root = await realDirectory(options.dir)
  } catch {
    io.err(`diorama: cannot serve "${options.dir}": not a readable directory`)
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
    io.err(`diorama: ${failure.message}`)
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
    printMount(io, mounted)
    if (mounted.created === false) io.out('already mounted (run "diorama restart <dir>" to reload)')
    if (mounted.pluginFailures !== undefined) {
      io.err(`diorama: ${mounted.pluginFailures}`)
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
    io.out(USAGE)
    return 0
  }
  if (error !== undefined) {
    io.err(`diorama: ${error}\n\n${USAGE}`)
    return 2
  }
  let root: string
  try {
    root = await realDirectory(options.dir)
  } catch {
    io.err(`diorama: cannot serve "${options.dir}": not a readable directory`)
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
    io.err(`diorama: ${failure.message}`)
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
    printMount(io, mounted)
    if (mounted.pluginFailures !== undefined) io.err(`diorama: ${mounted.pluginFailures}`)
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

/** The five lines `diorama <dir>` prints (contract.md §7.6). */
function printMount(io: CliIo, mounted: MountStatus): void {
  io.out(`diorama serving ${mounted.root}`)
  io.out(`  ${mounted.url}`)
  io.out(`  config: ${mounted.configFile ?? 'none (defaults)'}`)
  io.out(`  [mount:${mounted.mountId}] plugins: ${mounted.plugins.join(', ') || '(none)'}`)
  if (mounted.hidden.length > 0) io.out(`  hidden: ${mounted.hidden.join(', ')}`)
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
      io.err(`diorama: ${clean}`)
      return 1
    case 'ENOTDIR':
      io.err(`diorama: ${clean}`)
      return 2
    case 'EGATEWAYDEAD':
      io.err('diorama: the gateway is not running (run "diorama gateway start")')
      return 1
    default:
      io.err(`diorama: ${message}`)
      return 1
  }
}
