/**
 * The CLI's side of the control plane (contract.md §7.4–§7.6): start, stop,
 * status, restart, and the `ls` table. Every verb is a short-lived process
 * that talks to the gateway over `$DIORAMA_HOME/diorama[-beta].sock` and exits.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  connectControl,
  controlError,
  dioramaHome,
  resolveGatewayConfig,
  type ControlClient,
  type GatewayStatus,
  type MountStatus,
} from 'diorama-kernel/server'
import { logPath, pidPath, socketPath } from './gateway-command.ts'

/** How long a verb waits for the gateway socket before giving up (contract.md §7.4). */
export const CONNECT_TIMEOUT_MS = 5_000
/** How long `start` waits for a background gateway to answer `ping`. */
export const START_TIMEOUT_MS = 10_000
/** How long `stop` waits for the process to exit before escalating. */
export const STOP_TIMEOUT_MS = 5_000

export interface CliIo {
  /** stdout sink: one message, one line. */
  out(message: string): void
  /**
   * stdout sink **without** a trailing newline.
   *
   * The interactive wizard draws in place: `ESC[nA`, `ESC[J` and the frame are
   * three writes whose byte positions matter. Sending them through `out()`
   * appends a newline to each, which breaks the line accounting and makes every
   * redraw append a frame instead of replacing one.
   */
  raw(text: string): void
  /** stderr sink. */
  err(message: string): void
  env: NodeJS.ProcessEnv
  /** The command name to print (`diorama` or `diorama-beta`). */
  name?: string
}

/** The name to print in messages: the invoked binary name when known. */
export function cliName(io: { name?: string }): string {
  return io.name ?? 'diorama'
}

export function defaultIo(): CliIo {
  return {
    out: message => process.stdout.write(`${message}\n`),
    raw: text => process.stdout.write(text),
    err: message => process.stderr.write(`${message}\n`),
    env: process.env,
  }
}

/** `diorama`'s own executable, for a detached `gateway run` (contract.md §7.4). */
function cliExecutable(): { command: string; args: string[] } {
  const bin = fileURLToPath(new URL('../bin/diorama', import.meta.url))
  if (existsSync(bin)) return { command: process.execPath, args: [bin] }
  return { command: process.execPath, args: [process.argv[1] as string] }
}

/** Try to connect; `undefined` when the gateway is not running (or not yet answering). */
export async function tryConnect(io: CliIo = defaultIo(), timeoutMs = 0): Promise<ControlClient | undefined> {
  const path = socketPath(io.env)
  const started = Date.now()
  for (;;) {
    try {
      return await connectControl({ path, log: () => {} })
    } catch (failure) {
      const code = (failure as { code?: string }).code
      if (code !== 'EGATEWAYDEAD' && code !== 'ESTARTING') {
        if (Date.now() - started >= timeoutMs) return undefined
      }
      if (Date.now() - started >= timeoutMs) return undefined
      await delay(50)
    }
  }
}

/** `status` over a live connection; `undefined` when no gateway is running. */
export async function gatewayStatus(io: CliIo = defaultIo()): Promise<GatewayStatus | undefined> {
  const client = await tryConnect(io, 0)
  if (client === undefined) return undefined
  try {
    return (await client.request('status')) as GatewayStatus
  } finally {
    client.close()
  }
}

/** Run one control request, turning "no gateway" into `EGATEWAYDEAD`. */
export async function controlCall(io: CliIo, method: string, params: object = {}): Promise<unknown> {
  const client = await tryConnect(io, 0)
  if (client === undefined) throw controlError('EGATEWAYDEAD')
  try {
    return await client.request(method, params)
  } finally {
    client.close()
  }
}

/** Remove socket/pid leftovers only when nothing answers on the socket (contract.md §7.4). */
export function clearStaleFiles(env: NodeJS.ProcessEnv): void {
  rmSync(socketPath(env), { force: true })
  rmSync(pidPath(env), { force: true })
}

/**
 * `diorama gateway start`: spawn a detached gateway, then wait for `ping`.
 * Already running → success (`started: false`); the CLI prints which.
 */
export async function startGateway(io: CliIo = defaultIo()): Promise<{ started: boolean; status?: GatewayStatus }> {
  const existing = await gatewayStatus(io)
  if (existing !== undefined) return { started: false, status: existing }
  // The gateway's own settings come from `$DIORAMA_HOME/diorama.toml` (contract
  // §7.7). Read them **here** first: a broken file is a usage error this process
  // can report (exit 2, naming the file) instead of a daemon that dies and a
  // "did not answer" on the other end.
  resolveGatewayConfig({ home: dioramaHome(io.env) })

  const home = dioramaHome(io.env)
  mkdirSync(home, { recursive: true })
  const log = logPath(io.env)
  const out = openSync(log, 'a')
  const executable = cliExecutable()
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(executable.command, [...executable.args, 'gateway', 'run'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: io.env,
    })
    child.unref()
  } finally {
    closeSync(out)
  }
  const status = await waitForPing(io, START_TIMEOUT_MS, child)
  if (status === undefined) {
    // The daemon writes its own reason to the log (a taken index page port, a
    // broken diorama.toml, ...): quote it, or the reader has to go and look.
    const tail = logTail(log)
    const reason = child.exitCode === null
      ? `the gateway did not answer within ${START_TIMEOUT_MS}ms`
      : `the gateway exited before it answered (code ${child.exitCode})`
    throw controlError('ESTARTING', `${reason} (see ${log})${tail === '' ? '' : `\n  ${tail}`}`)
  }
  return { started: true, status }
}

/** The last few lines a daemon wrote before it gave up (bounded: a log can be huge). */
function logTail(path: string, lines = 5, maxChars = 1_200): string {
  try {
    const text = readFileSync(path, 'utf8')
    const tail = text.split('\n').filter(line => line !== '').slice(-lines).join('\n')
    return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail
  } catch {
    return ''
  }
}

/**
 * Poll `ping` until the gateway answers (a freshly spawned one needs a moment).
 *
 * A daemon that **exited** never will: stop waiting the moment its pid is gone
 * (a taken index page port, a broken `diorama.toml`), so the caller reports the
 * reason from the log instead of "did not answer in 10s".
 */
async function waitForPing(
  io: CliIo,
  timeoutMs: number,
  child?: { exitCode: number | null; killed: boolean },
): Promise<GatewayStatus | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await gatewayStatus(io)
    if (status !== undefined) return status
    if (child !== undefined && child.exitCode !== null) return undefined
    await delay(50)
  }
  return undefined
}

/**
 * `diorama gateway stop`: ask the gateway to stop; `force` escalates to
 * `SIGKILL` after `STOP_TIMEOUT_MS`. Not running is a successful no-op
 * (contract.md §7.6: exit 0).
 */
export async function stopGateway(io: CliIo = defaultIo(), force = false): Promise<{ stopped: boolean }> {
  const status = await gatewayStatus(io)
  if (status === undefined) {
    clearStaleFiles(io.env)
    return { stopped: false }
  }
  const client = await tryConnect(io, 0)
  if (client !== undefined) {
    try {
      await client.request('stop', { force })
    } catch {
      // The socket may already be closing; fall through to the pid check.
    } finally {
      client.close()
    }
  }
  const exited = await waitForExit(status.pid, STOP_TIMEOUT_MS)
  if (!exited) {
    if (!force) {
      throw controlError('EBADREQUEST', `gateway (pid ${status.pid}) did not stop within ${STOP_TIMEOUT_MS}ms; retry with --force`)
    }
    try {
      process.kill(status.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  clearStaleFiles(io.env)
  return { stopped: true }
}

/** Wait until a pid is gone; `true` when it exited. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isAlive(pid)) return true
    if (Date.now() > deadline) return false
    await delay(50)
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** `diorama gateway restart`: stop, then start. Mounts are **not** preserved. */
export async function restartGateway(io: CliIo = defaultIo()): Promise<{ status?: GatewayStatus }> {
  await stopGateway(io)
  const { status } = await startGateway(io)
  return { status }
}

/** The pid file's content, when a gateway left one behind. */
export function readPidFile(env: NodeJS.ProcessEnv): { pid: number; socket: string; startedAt: number } | undefined {
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

/** The log file the detached gateway writes to (per channel, like the socket). */
export function gatewayLogPath(env: NodeJS.ProcessEnv): string {
  return logPath(env)
}

// --- `diorama ls` (contract.md §7.6) ---------------------------------------

/** Fixed-width column values; widths come from the data, not from guessing. */
function columnWidths(rows: readonly (readonly string[])[]): number[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return widths
}

/** One padded row; the final column is never padded (no trailing spaces). */
function formatRow(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join('  ')
}

/**
 * The mount table (contract.md §7.6): MOUNT PORT STATUS DIR URL CONFIG.
 *
 * When the gateway has an index page (contract.md §7.7) it is named **before**
 * the table: it is the one address that still works after a restart, so it is
 * the one worth copying. It goes to stdout as a comment line so the table
 * itself stays the machine-readable part.
 */
export function formatMounts(mounts: readonly MountStatus[], index?: string): string {
  const header = ['MOUNT', 'PORT', 'STATUS', 'DIR', 'URL', 'CONFIG']
  const rows = mounts.map(mount => [
    mount.mountId,
    String(mount.port),
    mount.state,
    mount.root,
    mount.url,
    mount.configFile ?? '(defaults)',
  ])
  const widths = columnWidths([header, ...rows])
  const table = [formatRow(header, widths), ...rows.map(row => formatRow(row, widths))]
  return index === undefined ? table.join('\n') : [`index: ${index}`, ...table].join('\n')
}

/** `diorama ls`: the table, `--json`, and the two no-gateway / no-mount messages. */
export async function listMounts(io: CliIo = defaultIo(), options: { json?: boolean } = {}): Promise<number> {
  const status = await gatewayStatus(io)
  if (status === undefined) {
    if (options.json) io.out(JSON.stringify({ running: false, mounts: [] }, null, 2))
    else io.out(`gateway is not running (run "${cliName(io)} gateway start")`)
    // `ls` is a query, not an error (contract.md §7.6).
    return 0
  }
  if (options.json) {
    io.out(JSON.stringify({ running: true, gateway: status, mounts: status.mounts }, null, 2))
    return 0
  }
  if (status.mounts.length === 0) {
    io.out(`no mounts (run "${cliName(io)} <dir>")`)
    return 0
  }
  io.out(formatMounts(status.mounts, status.index))
  return 0
}
