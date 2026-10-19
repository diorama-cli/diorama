/**
 * `diorama gateway …` (contract.md §7.4).
 *
 * `run` is the foreground daemon: `start` spawns it detached, `--foreground`
 * runs it in this process, and the tests spawn it directly. The other verbs
 * are short-lived clients of the control socket.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dioramaHome } from 'diorama-kernel/server'
import { serveGateway, type StoppableGateway } from './gateway.ts'
import { assetsRoot } from './run.ts'

/** `$DIORAMA_HOME/diorama.sock` (contract.md §7.1). */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dioramaHome(env), 'diorama.sock')
}

/** `$DIORAMA_HOME/gateway.pid` (contract.md §7.4). */
export function pidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dioramaHome(env), 'gateway.pid')
}

/** `$DIORAMA_HOME/gateway.log`: the detached daemon's console (contract.md §7.4). */
export function logPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dioramaHome(env), 'gateway.log')
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv
  /** Console sink (the daemon writes it to `gateway.log` when detached). */
  log?: (message: string) => void
}

/**
 * Run the gateway in the foreground until `close()` (used by `gateway run`
 * and by `--foreground`). Resolves when the socket is bound.
 */
export async function runGateway(options: RunOptions = {}): Promise<StoppableGateway> {
  const env = options.env ?? process.env
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))
  return serveGateway({
    socket: socketPath(env),
    pidFile: pidPath(env),
    assets: assetsRoot(env),
    log,
  })
}

/** The pid file's content, when a gateway left one behind (contract.md §7.4). */
export function readPid(env: NodeJS.ProcessEnv = process.env): { pid: number; socket: string; startedAt: number } | undefined {
  const path = pidPath(env)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; socket?: unknown; startedAt?: unknown }
    if (typeof parsed.pid !== 'number') return undefined
    return { pid: parsed.pid, socket: String(parsed.socket ?? ''), startedAt: Number(parsed.startedAt ?? 0) }
  } catch {
    return undefined
  }
}
