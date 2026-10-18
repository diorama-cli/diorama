/**
 * The `diorama` command (M0): serve one directory in the foreground.
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
  BUILTIN_PLUGIN_IDS,
  bootPlugins,
  createMountServer,
  listen,
  planPlugins,
  type BootManifest,
} from 'diorama-kernel/server'
import { loadServerHalf } from './plugins-server.ts'

export interface CliOptions {
  dir: string
  port: number
  host: string
  /** Plugin ids to load; defaults to the static assembly list. */
  plugins: readonly string[]
  /** Simulate a plugin missing its `name` export: `"<id>:name"`. */
  breakPlugin?: string
  /** Print the boot plan and exit; may run without built assets. */
  dumpPlan: boolean
}

export interface ParsedArgs {
  options: CliOptions
  /** Usage problem; when set, print it and exit non-zero. */
  error?: string
}

const USAGE = `Usage: diorama [dir] [options]

Serve one directory as a read-only diorama in the browser (foreground).

Options:
  --port <n>              Port to listen on (default: random free port)
  --host <ip>             Interface to bind (default: 127.0.0.1)
  --plugins <a,b,...>     Built-in plugins to load (default: all)
  --break-plugin <id:name>
                          Simulate a broken plugin, e.g. "plaintext:name"
  --dump-plan             Print the plugin boot plan as JSON and exit
  -h, --help              Show this help

Environment:
  DIORAMA_HOME            Directory holding the built web assets
                          (default: packages/cli/web, then apps/web/dist)
`

/** Parse argv (without `node` and the script path). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let dir: string | undefined
  let port = 0
  let host = '127.0.0.1'
  let plugins: string[] = [...BUILTIN_PLUGIN_IDS]
  let breakPlugin: string | undefined
  let dumpPlan = false

  const takeValue = (index: number, flag: string): [string, number] | string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) return `option ${flag} needs a value`
    return [value, index + 1]
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (arg === '-h' || arg === '--help') return { options: { dir: '', port, host, plugins, dumpPlan: true }, error: 'help' }
    if (arg === '--dump-plan') {
      dumpPlan = true
      continue
    }
    if (arg === '--port' || arg === '--host' || arg === '--plugins' || arg === '--break-plugin') {
      const taken = takeValue(index, arg)
      if (typeof taken === 'string') return { options: { dir: '', port, host, plugins, dumpPlan }, error: taken }
      const [value, next] = taken
      index = next
      if (arg === '--port') {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          return { options: { dir: '', port, host, plugins, dumpPlan }, error: `invalid --port "${value}"` }
        }
        port = parsed
      } else if (arg === '--host') {
        host = value
      } else if (arg === '--plugins') {
        plugins = value
          .split(',')
          .map(id => id.trim())
          .filter(id => id !== '')
      } else {
        breakPlugin = value
      }
      continue
    }
    if (arg.startsWith('--')) {
      return { options: { dir: '', port, host, plugins, dumpPlan }, error: `unknown option "${arg}"` }
    }
    if (dir !== undefined) {
      return { options: { dir: '', port, host, plugins, dumpPlan }, error: `unexpected argument "${arg}"` }
    }
    dir = arg
  }

  return { options: { dir: dir ?? '.', port, host, plugins, breakPlugin, dumpPlan } }
}

/** Directory containing this CLI's built code (`lib/`, bundled flat by tsdown). */
export function packageDir(): string {
  return fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
}

/** Locate the built shell assets. */
export function assetsRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DIORAMA_HOME !== undefined && env.DIORAMA_HOME !== '') return resolve(env.DIORAMA_HOME)
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

  const mountId = newMountId()
  let manifest: BootManifest
  try {
    manifest = planPlugins(options.plugins, mountId, root)
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
        'run "pnpm build" first, or set DIORAMA_HOME to a directory containing index.html\n',
    )
    return 2
  }

  // Server half: a real Cordis tree per served directory (architecture.md §11).
  const tree = await bootPlugins({
    plugins: await selectPlugins(options.plugins, options.breakPlugin),
    root,
    mountId,
  })
  const clientEntries = new Map(manifest.plugins.map(plugin => [plugin.id, plugin.clientEntry]))

  const server = createMountServer(
    { root, mountId, assetsRoot: assets, clientEntries },
    manifest,
  )
  let port: number
  try {
    port = await listen(server, options.host, options.port)
  } catch (failure) {
    const code = (failure as { code?: string }).code
    process.stderr.write(
      code === 'EADDRINUSE'
        ? `diorama: port ${options.port} is already in use\n`
        : `diorama: cannot listen on ${options.host}:${options.port}: ${(failure as Error).message}\n`,
    )
    await tree.stop()
    return 2
  }

  const displayHost = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}/`
  process.stdout.write(`diorama serving ${root}\n`)
  process.stdout.write(`  ${url}\n`)
  process.stdout.write(`  [mount:${mountId}] plugins: ${options.plugins.join(', ') || '(none)'}\n`)

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
      server.closeAllConnections()
      server.close(() => resolveShutdown())
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
