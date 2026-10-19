/**
 * The gateway's mount table (contract.md §3.5, §7.3): one HTTP port per
 * mounted directory, and the control plane's `mount` / `unmount` / `list`.
 *
 * This module owns *transport-level* lifecycles only — the HTTP listener and
 * its RPC channel. The per-directory Cordis service instances (contract.md
 * §2.5) live in `./mounts.ts`, which wraps this class; splitting them keeps the
 * port/URL bookkeeping testable without a plugin tree.
 */
import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { controlError, type MountStatus } from '../shared/control.ts'
import type { EffectiveConfig } from './config.ts'
import { createMountServer, listen, type MountServer } from './http.ts'
import type { BootManifest } from './plan.ts'
import type { RpcDispatcher } from './rpc.ts'

/** How many free ports a random-port mount tries before giving up (contract.md §7.3). */
export const MAX_PORT_ATTEMPTS = 20

/** The per-directory tree the gateway boots once a mount's port is known (contract.md §2.5). */
export interface MountTree {
  /** The RPC dispatcher of this mount (contract.md §4); created by the owner. */
  dispatcher: RpcDispatcher
  /** Shut the tree down: listeners first, then disposers, then the fork context. */
  dispose(): Promise<void>
}

export interface GatewayMountInput {
  /** Absolute directory (the CLI resolved it; `mount` re-realpaths it). */
  root: string
  config: EffectiveConfig
  configFile?: string
  /** Client half entry per plugin id (from the boot plan). */
  clientEntries: ReadonlyMap<string, string>
  /** `BootManifest` for `/plugin.json`; called with the final port and URL. */
  manifest(mountId: string, port: number, url: string): BootManifest
  /** Boot the per-directory tree; its dispatcher serves that mount's RPC channel. */
  boot(mountId: string, port: number, url: string): Promise<MountTree>
}

/** One mounted directory, as the gateway keeps it. */
export interface GatewayMount {
  status: MountStatus
  /** The HTTP server of this mount (RPC channel included); absent until bound. */
  server?: MountServer
  /** The per-directory tree; absent until booted. */
  tree?: MountTree
}

export interface GatewayOptions {
  /** Assets directory of the built shell. */
  assetsRoot: string
  /** Console sink; defaults to `console.error`. */
  log?: (message: string) => void
}

/** Whether a bound port is on every interface (the URL must not say `0.0.0.0`). */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

/** `http://host:port/` with IPv6 brackets. */
export function mountUrl(host: string, port: number): string {
  const shown = displayHost(host)
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}/`
}

/** Ids appear in log prefixes and are never reused (contract.md §2.5). */
export function newMountId(): string {
  return randomBytes(4).toString('hex')
}

/** A free TCP port on `host` in preference order (contract.md §7.3). */
async function reservePort(host: string, wanted: number): Promise<number> {
  if (wanted !== 0) {
    // An explicit port is the user's intent: a conflict is an error, never a silent retry.
    if (await portIsFree(host, wanted)) return wanted
    throw controlError('EADDRINUSE', `port ${wanted} is already in use`)
  }
  let last: unknown
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    // Pick a free port by binding a bare listener and releasing it. The window
    // between release and the mount's bind is the one contract.md §7.3 accepts
    // for random ports ("bind 成功者胜出 + 重试"): a losing bind lands below.
    try {
      return await probePort(host)
    } catch (failure) {
      last = failure
    }
  }
  throw controlError('EBADREQUEST', `no free port after ${MAX_PORT_ATTEMPTS} attempts (${(last as Error)?.message ?? 'unknown error'})`)
}

/** Whether `host:port` can be bound right now. */
async function portIsFree(host: string, port: number): Promise<boolean> {
  const probe = createServer()
  try {
    await new Promise<void>((resolveListen, reject) => {
      probe.once('error', reject)
      probe.listen(port, host, () => resolveListen())
    })
    return true
  } catch (failure) {
    const code = (failure as { code?: string }).code
    if (code === 'EADDRINUSE') return false
    throw failure
  } finally {
    await new Promise<void>(done => probe.close(() => done()))
  }
}

/** Bind port 0, report the port, release it. */
async function probePort(host: string): Promise<number> {
  const probe = createServer()
  try {
    await new Promise<void>((resolveListen, reject) => {
      probe.once('error', reject)
      probe.listen(0, host, () => resolveListen())
    })
    const address = probe.address()
    if (address === null || typeof address === 'string') throw new Error('no TCP address')
    return address.port
  } finally {
    await new Promise<void>(done => probe.close(() => done()))
  }
}

/** Listen the mount server; a lost race on a random port is retried by the caller. */
async function listenPort(server: MountServer, host: string, port: number): Promise<void> {
  await listen(server.server, host, port).catch(async (failure: Error) => {
    await server.close()
    if ((failure as { code?: string }).code === 'EADDRINUSE') {
      throw controlError('EADDRINUSE', `port ${port} is already in use`)
    }
    throw failure
  })
}

/**
 * The mount table. Mounting is idempotent per root (contract.md §7.3); a mount
 * is only visible in `list()` once its port is bound and its tree is booted.
 */
export class Gateway {
  private readonly mounts = new Map<string, GatewayMount>()
  private readonly byRoot = new Map<string, string>()
  /** Ports already handed out in this process (a just-released port must not be reused silently). */
  private readonly usedPorts = new Set<number>()
  private readonly log: (message: string) => void

  constructor(private readonly options: GatewayOptions) {
    this.log = options.log ?? ((message: string) => console.error(message))
  }

  /** Every live mount, in mount order (contract.md §3.5: `mounts.list()`). */
  list(): MountStatus[] {
    return [...this.mounts.values()].map(mount => ({ ...mount.status }))
  }

  /** One mount's status copy, or `undefined`. */
  get(mountId: string): MountStatus | undefined {
    const mount = this.mounts.get(mountId)
    return mount === undefined ? undefined : { ...mount.status }
  }

  /** The mount serving `root` (realpath), or `undefined` (contract.md §7.3 idempotency). */
  find(root: string): GatewayMount | undefined {
    const mountId = this.byRoot.get(root)
    return mountId === undefined ? undefined : this.mounts.get(mountId)
  }

  /** Like {@link find}, but resolves a symlinked input first (unmount by path). */
  async findByRoot(input: string): Promise<GatewayMount | undefined> {
    const root = await realpath(input).catch(() => input)
    return this.find(root)
  }

  /**
   * Mount one directory. Resolves the real path, binds a port, then boots the
   * per-directory tree. An existing mount of the same root is returned as is
   * (`created: false`) — its port and configuration do not change.
   */
  async mount(input: GatewayMountInput): Promise<{ mount: GatewayMount; created: boolean }> {
    let root: string
    try {
      root = await realpath(input.root)
      if (!(await stat(root)).isDirectory()) throw new Error('not a directory')
    } catch {
      throw controlError('ENOTDIR', `cannot mount "${input.root}": not a readable directory`)
    }
    const existing = this.find(root)
    if (existing !== undefined) return { mount: existing, created: false }

    const mountId = newMountId()
    const host = input.config.host
    const status: MountStatus = {
      mountId,
      root,
      port: 0,
      url: '',
      state: 'starting',
      since: Date.now(),
      ...(input.configFile === undefined ? {} : { configFile: input.configFile }),
      plugins: [...input.config.plugins],
      hidden: [...input.config.ignore],
    }
    /** Filled in once the port is bound and the tree booted (see contract.md §2.5). */
    const mount: GatewayMount = { status }
    // Visible while `starting` so a concurrent `unmount` can find it.
    this.mounts.set(mountId, mount)
    try {
      // Bind a bare listener first to learn the port, then build the server
      // that its manifest needs (contract.md §7.3: the URL carries the port).
      const port = await reservePort(host, input.config.port)
      this.usedPorts.add(port)
      const url = mountUrl(host, port)
      status.port = port
      status.url = url
      const tree = await input.boot(mountId, port, url)
      mount.tree = tree
      const server = createMountServer({
        root,
        mountId,
        assetsRoot: this.options.assetsRoot,
        clientEntries: input.clientEntries,
        dispatcher: tree.dispatcher,
        manifest: input.manifest(mountId, port, url),
        log: message => this.log(`[mount:${mountId}] ${message}`),
      })
      mount.server = server
      await listenPort(server, host, port)
      mount.status = { ...mount.status, state: 'ok', since: Date.now() }
      this.byRoot.set(root, mountId)
      return { mount, created: true }
    } catch (failure) {
      this.mounts.delete(mountId)
      await mount.server?.close().catch(() => {})
      await mount.tree?.dispose().catch(() => {})
      throw failure
    }
  }

  /**
   * Unmount by id or root. The order is contract.md §2.5: close the listener
   * and its RPC peers first (which cancels their subscriptions), then run the
   * tree's disposers, then dispose the forked context.
   */
  async unmount(selector: { mountId?: string; root?: string }): Promise<{ mountId: string; root: string } | undefined> {
    let mountId = selector.mountId
    if (mountId === undefined && selector.root !== undefined) {
      const wanted = selector.root
      const root = await realpath(wanted).catch(() => wanted)
      mountId = this.byRoot.get(root)
    }
    if (mountId === undefined) throw controlError('ENOMOUNT', 'unmount needs a mountId or a root')
    const mount = this.mounts.get(mountId)
    if (mount === undefined) return undefined // already gone: idempotent
    this.mounts.delete(mountId)
    this.byRoot.delete(mount.status.root)
    mount.status = { ...mount.status, state: 'stopped', since: Date.now() }
    try {
      await mount.server?.close()
    } catch (failure) {
      this.log(`[mount:${mountId}] error closing the listener: ${(failure as Error).message}`)
    }
    try {
      await mount.tree?.dispose()
    } catch (failure) {
      this.log(`[mount:${mountId}] error disposing the tree: ${(failure as Error).message}`)
    }
    return { mountId, root: mount.status.root }
  }

  /** Unmount everything (gateway stop). Best effort: one failure does not stop the rest. */
  async close(): Promise<void> {
    for (const mountId of [...this.mounts.keys()]) {
      await this.unmount({ mountId })
    }
  }

  /** Ports this gateway has ever handed out (diagnostics; not the set of live ports). */
  get ports(): number[] {
    return [...this.usedPorts]
  }
}
