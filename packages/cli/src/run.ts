/**
 * The `diorama` command: serve one directory in the foreground.
 *
 * Configuration is `diorama.toml` + CLI + defaults (contract.md §4.1); the CLI
 * carries `undefined` for "not given" so a toml value is never shadowed by a
 * CLI default.
 *
 * `--plugins` / `--break-plugin` are verification switches: they let the M0
 * acceptance scenarios (plan.md) be reproduced without editing sources.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  builtinSource,
  ConfigError,
  bootPlugins,
  createDispatcher,
  createMountServer,
  dioramaHome,
  rpcError,
  listen,
  planPlugins,
  resolveConfig,
  type BootManifest,
  type ConfigOrigin,
  type EffectiveConfig,
  type RpcDispatcher,
} from 'diorama-kernel/server'
import { loadServerHalf } from './plugins-server.ts'

export interface CliOptions {
  dir: string
  /** `undefined` = take `diorama.toml`, then the default (`0` = a free port). */
  port?: number
  /** `undefined` = take `diorama.toml`, then `127.0.0.1`. */
  host?: string
  /** `undefined` = take `diorama.toml`, then every built-in plugin. */
  plugins?: readonly string[]
  /** Explicit `diorama.toml`; skips the lookup in the directory and `$DIORAMA_HOME`. */
  config?: string
  /** `--all`: show everything (no ignore rules). */
  all: boolean
  /** Simulate a plugin missing its `name` export: `"<id>:name"`. */
  breakPlugin?: string
  /** Print the boot plan and exit; may run without built assets. */
  dumpPlan: boolean
  /** Print the effective configuration and exit. */
  dumpConfig: boolean
}

export interface ParsedArgs {
  options: CliOptions
  /** Usage problem; when set, print it and exit non-zero. */
  error?: string
}

const USAGE = `Usage: diorama [dir] [options]

Serve one directory as a read-only diorama in the browser (foreground).

Configuration comes from diorama.toml (the served directory, then
$DIORAMA_HOME) and is overridden by these options:

  --port <n>              Port to listen on (default from diorama.toml, else random)
  --host <ip>             Interface to bind (default from diorama.toml, else 127.0.0.1)
  --plugins <a,b,...>     Built-in plugins to load (default from diorama.toml, else all)
  --config <path>         Read this diorama.toml instead of looking one up
  --all                   Show ignored entries too (.git, node_modules, ignore = [])
  --break-plugin <id:name>
                          Simulate a broken plugin, e.g. "plaintext:name"
  --dump-plan             Print the plugin boot plan as JSON and exit
  --dump-config           Print the effective configuration as JSON and exit
  -h, --help              Show this help

Environment:
  DIORAMA_HOME            State directory (default ~/.diorama): the fallback
                          diorama.toml, the gateway socket, pid file and log
`

/** Parse argv (without `node` and the script path). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let dir: string | undefined
  let port: number | undefined
  let host: string | undefined
  let plugins: string[] | undefined
  let config: string | undefined
  let all = false
  let breakPlugin: string | undefined
  let dumpPlan = false
  let dumpConfig = false

  const current = (): CliOptions => ({
    dir: '',
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host }),
    ...(plugins === undefined ? {} : { plugins }),
    ...(config === undefined ? {} : { config }),
    all,
    ...(breakPlugin === undefined ? {} : { breakPlugin }),
    dumpPlan,
    dumpConfig,
  })

  const takeValue = (index: number, flag: string): [string, number] | string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) return `option ${flag} needs a value`
    return [value, index + 1]
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (arg === '-h' || arg === '--help') return { options: current(), error: 'help' }
    if (arg === '--dump-plan') {
      dumpPlan = true
      continue
    }
    if (arg === '--dump-config') {
      dumpConfig = true
      continue
    }
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg === '--port' || arg === '--host' || arg === '--plugins' || arg === '--break-plugin' || arg === '--config') {
      const taken = takeValue(index, arg)
      if (typeof taken === 'string') return { options: current(), error: taken }
      const [value, next] = taken
      index = next
      if (arg === '--port') {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          return { options: current(), error: `invalid --port "${value}"` }
        }
        port = parsed
      } else if (arg === '--host') {
        host = value
      } else if (arg === '--plugins') {
        plugins = value
          .split(',')
          .map(id => id.trim())
          .filter(id => id !== '')
      } else if (arg === '--config') {
        config = value
      } else {
        breakPlugin = value
      }
      continue
    }
    if (arg.startsWith('--')) {
      return { options: current(), error: `unknown option "${arg}"` }
    }
    if (dir !== undefined) {
      return { options: current(), error: `unexpected argument "${arg}"` }
    }
    dir = arg
  }

  return { options: { ...current(), dir: dir ?? '.' } }
}

/** Directory containing this CLI's built code (`lib/`, bundled flat by tsdown). */
export function packageDir(): string {
  return fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
}

/**
 * Locate the built shell assets.
 *
 * The CLI package carries them in `web/` when published; in a checkout they
 * come from `apps/web/dist`. `DIORAMA_HOME` is the state directory and is *not*
 * searched here (contract.md §4.1, v0.4).
 */
export function assetsRoot(_env: NodeJS.ProcessEnv = process.env): string {
  const packaged = join(packageDir(), 'web')
  if (existsSync(join(packaged, 'index.html'))) return packaged
  return resolve(packageDir(), '../../apps/web/dist')
}

/** Load the server halves for the tree, optionally breaking one plugin. */
export async function selectPlugins(ids: readonly string[], breakPlugin?: string): Promise<unknown[]> {
  const [breakId, breakExport] = (breakPlugin ?? '').split(':')
  const halves = await Promise.all(ids.map(id => loadServerHalf(id)))
  return halves.map((half: unknown, index: number) => {
    if (half === undefined) return half
    const id = ids[index]
    if (breakId !== id) return half
    // Simulate a plugin that forgot to export `name` (M0 acceptance point 5).
    if (breakExport === undefined || breakExport === 'name') {
      const { name: _name, ...rest } = half as Record<string, unknown>
      return rest
    }
    return { ...(half as object), name: '' }
  })
}

/**
 * Teach the dispatcher about subscription endpoints (contract.md §4): a call to
 * `<service>.watch` registers a push and returns the disposer that ends it.
 */
export function withSubscriptions(dispatcher: RpcDispatcher, services: () => Record<string, unknown>): RpcDispatcher {
  return {
    ...dispatcher,
    async subscribe(method, args, push) {
      const [service, name] = method.split('.')
      if (service === undefined || name === undefined) throw new Error(`subscribe: bad method "${method}"`)
      const target = services()[service]
      const callable = (target as Record<string, unknown> | undefined)?.[name]
      if (target === undefined || typeof callable !== 'function') {
        throw rpcError('EMETHOD', `${method} is not a subscription`)
      }
      const dispose = (callable as (...params: unknown[]) => unknown).apply(target, [args[0] ?? '', push])
      if (typeof dispose !== 'function') {
        throw rpcError('EMETHOD', `${method} did not return a disposer`)
      }
      return dispose as () => void
    },
  }
}

/** Characters allowed in a mount id (it appears in logs as `[mount:<id>]`). */
export function newMountId(): string {
  return randomBytes(4).toString('hex')
}

/**
 * CLI entry. Returns the process exit code when the process should exit
 * immediately (help, errors, `--dump-plan`); otherwise it keeps running and
 * returns `undefined`.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number | undefined> {
  const { options, error } = parseArgs(argv)
  if (error === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  if (error !== undefined) {
    process.stderr.write(`diorama: ${error}\n\n${USAGE}`)
    return 2
  }

  let root: string
  try {
    root = await realpath(resolve(options.dir))
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory')
  } catch {
    process.stderr.write(`diorama: cannot serve "${options.dir}": not a readable directory\n`)
    return 2
  }

  // diorama.toml + CLI + defaults, merged once (contract.md §4.1). A bad file
  // is fail loud: the message names it, nothing is guessed.
  let config: EffectiveConfig
  let origin: ConfigOrigin
  try {
    ;({ config, origin } = resolveConfig({
      root,
      home: dioramaHome(env),
      ...(options.config === undefined ? {} : { configPath: options.config }),
      cli: {
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
        all: options.all,
      },
    }))
  } catch (failure) {
    if (!(failure instanceof ConfigError)) throw failure
    process.stderr.write(`diorama: ${failure.message}\n`)
    return 2
  }

  if (options.dumpConfig) {
    process.stdout.write(`${JSON.stringify({ config, configFile: origin.path ?? null }, null, 2)}\n`)
    return 0
  }

  const mountId = newMountId()
  let manifest: BootManifest
  try {
    manifest = planPlugins(config.plugins, mountId, root, builtinSource, config)
  } catch (failure) {
    process.stderr.write(`diorama: ${(failure as Error).message}\n`)
    return 2
  }

  if (options.dumpPlan) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
    return 0
  }

  const assets = assetsRoot(env)
  if (!existsSync(join(assets, 'index.html'))) {
    process.stderr.write(
      `diorama: built web assets not found at ${assets}\n` +
        'run "pnpm build" first, or install a CLI build that ships its web assets\n',
    )
    return 2
  }

  // Server half: a real Cordis tree per served directory (architecture.md §11).
  // `fs` is infrastructure on this side — it has no client half, so `--plugins`
  // (a client-graph selection) can neither add nor remove it.
  const serverIds = [...new Set(['fs', ...config.plugins])]
  const tree = await bootPlugins({
    plugins: await selectPlugins(serverIds, options.breakPlugin),
    root,
    mountId,
    config,
  })
  const clientEntries = new Map(manifest.plugins.map(plugin => [plugin.id, plugin.clientEntry]))

  // RPC (contract.md §4): services on the mount context are proxyable. Only
  // services a plugin *provided* are exposed; `get` also finds built-in Cordis
  // names (`logger`, …), which the allow-list below filters out.
  const proxyable = (): Record<string, unknown> => {
    const services: Record<string, unknown> = {}
    for (const name of ['fs'] as const) {
      const service = (tree.mount as unknown as { get(name: string): unknown }).get(name)
      if (service !== undefined && typeof (service as { describe?: unknown }).describe === 'function') {
        services[name] = service
      }
    }
    return services
  }
  const mountServer = createMountServer({
    root,
    mountId,
    assetsRoot: assets,
    clientEntries,
    dispatcher: withSubscriptions(createDispatcher(proxyable), proxyable),
    manifest,
  })
  const server = mountServer.server
  let port: number
  try {
    port = await listen(server, config.host, config.port)
  } catch (failure) {
    const code = (failure as { code?: string }).code
    process.stderr.write(
      code === 'EADDRINUSE'
        ? `diorama: port ${config.port} is already in use\n`
        : `diorama: cannot listen on ${config.host}:${config.port}: ${(failure as Error).message}\n`,
    )
    await tree.stop()
    return 2
  }

  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}/`
  process.stdout.write(`diorama serving ${root}\n`)
  process.stdout.write(`  ${url}\n`)
  process.stdout.write(`  config: ${origin.path ?? 'none (defaults)'}\n`)
  process.stdout.write(`  [mount:${mountId}] plugins: ${config.plugins.join(', ') || '(none)'}\n`)
  if (config.ignore.length > 0) process.stdout.write(`  hidden: ${config.ignore.join(', ')}\n`)

  if (tree.failures.length > 0) {
    process.stderr.write(
      `diorama: ${tree.failures.length} plugin(s) failed:\n` +
        tree.failures.map(failure => `  - ${failure.id}: ${failure.message}`).join('\n') +
        '\n',
    )
  }

  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      void mountServer.close().then(resolveShutdown)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    server.on('error', (failure) => {
      process.stderr.write(`diorama: server error: ${failure.message}\n`)
      shutdown()
    })
  })
  await tree.stop()
  return tree.failures.length > 0 ? 1 : 0
}

export { USAGE }
