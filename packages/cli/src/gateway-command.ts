/**
 * `diorama gateway …` (contract.md §7.4).
 *
 * `run` is the foreground daemon: `start` spawns it detached, `--foreground`
 * runs it in this process, and the tests spawn it directly. The other verbs
 * are short-lived clients of the control socket (`diorama[-beta].sock`).
 */
import { join } from 'node:path'
import { dioramaHome } from 'diorama-kernel/server'
import { serveGateway, type StoppableGateway } from './gateway.ts'
import { assetsRoot } from './run.ts'

/**
 * This build's identity (contract.md §7.1, §7.4). A **beta** build is a linked
 * checkout: its state directory, socket, pid file and log are all suffixed, so
 * it never talks to — or fights over — an installed `diorama`'s gateway.
 * `dist` (the released build) keeps the plain names and binds `diorama.sock`.
 */
export type BuildChannel = 'dist' | 'beta'

/** The channel this process is: `beta` when linked, `dist` otherwise. */
export function buildChannel(env: NodeJS.ProcessEnv = process.env): BuildChannel {
  return env.DIORAMA_CHANNEL === 'beta' ? 'beta' : 'dist'
}

/** `beta` → `-beta`, `dist` → `` (the suffix every state path uses). */
export function channelSuffix(channel: BuildChannel = buildChannel()): string {
  return channel === 'beta' ? '-beta' : ''
}

/** `$DIORAMA_HOME/diorama.sock` (contract.md §7.1). */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dioramaHome(env), `diorama${channelSuffix(buildChannel(env))}.sock`)
}

/** `$DIORAMA_HOME/gateway.pid` (contract.md §7.4). */
export function pidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dioramaHome(env), `gateway${channelSuffix(buildChannel(env))}.pid`)
}

/** `$DIORAMA_HOME/gateway.log`: the detached daemon's console (contract.md §7.4). */
export function logPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dioramaHome(env), `gateway${channelSuffix(buildChannel(env))}.log`)
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
