/**
 * The resident gateway (contract.md §7): one process, one HTTP port per mounted
 * directory, one Cordis tree per directory.
 *
 * The kernel owns the mount table (`Gateway` in `diorama-kernel/server`:
 * realpath, port binding, HTTP listener, RPC channel). This module owns what
 * only the CLI build can do: assemble server halves, boot a tree per mount, and
 * serve the control plane on `$DIORAMA_HOME/diorama[-beta].sock`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  builtinSource,
  onMountFailure,
  CONTROL_PROTOCOL,
  CONTRACT_VERSION,
  CONTROL_TOPICS,
  connectControl,
  createControlServer,
  createDispatcher,
  createPluginHost,
  forkMount,
  Gateway,
  planPlugins,
  type BootManifest,
  type ControlServer,
  type ControlTopic,
  type EffectiveConfig,
  type GatewayInfo,
  type GatewayStatus,
  type MountStatus,
  type MountTree,
  type PluginHost,
  type RpcDispatcher,
} from 'diorama-kernel/server'
import { assetsRoot, selectPlugins, withSubscriptions } from './run.ts'

/** What `diorama gateway run` was told (the CLI parsed it; the gateway obeys it). */
export interface GatewayServeOptions {
  /** Unix socket path (`$DIORAMA_HOME/diorama[-beta].sock`). */
  socket: string
  /** Where the built shell lives; defaults to `assetsRoot()`. */
  assets?: string
  /** Console sink; the daemon writes it to `$DIORAMA_HOME/gateway.log`. */
  log?: (message: string) => void
  /** Written once the socket is bound, removed on shutdown (contract.md §7.4). */
  pidFile?: string
}

export interface StoppableGateway {
  readonly info: GatewayInfo
  /** The bound control socket. */
  readonly socket: ControlServer
  readonly mounts: Gateway
  /** Unmount everything, then drop the control socket. */
  close(): Promise<void>
}

/** Mount parameters as the CLI sends them (contract.md §7.3). */
export interface MountParams {
  root: string
  config: EffectiveConfig
  configFile?: string
  /** Verification switch (M0 acceptance point 5). */
  breakPlugin?: string
}

/** Services a mount may proxy over RPC (contract.md §4); only these leave the tree. */
const PROXYABLE = ['fs', 'git'] as const

/**
 * Boot the gateway: bind the control socket, then answer control requests.
 * Rejects when the socket cannot be bound (another gateway owns it).
 */
export async function serveGateway(options: GatewayServeOptions): Promise<StoppableGateway> {
  const log = options.log ?? ((message: string) => console.error(message))
  const assets = options.assets ?? assetsRoot()
  const mounts = new Gateway({ assetsRoot: assets, log })
  /** Per-mount trees, so a dispatcher can reach the services of its own mount. */
  const trees = new Map<string, MountTree>()
  const info: GatewayInfo = {
    pid: process.pid,
    version: process.env.DIORAMA_VERSION ?? '0.0.1-m3',
    contract: CONTRACT_VERSION,
    protocol: CONTROL_PROTOCOL,
    startedAt: Date.now(),
  }
  /** Degraded at the process level: an error nobody could attribute (contract.md §11). */
  let gatewayState: GatewayStatus['state'] = 'ok'
  let closing = false

  const status = (): GatewayStatus => ({ ...info, state: gatewayState, mounts: mounts.list() })

  /**
   * The plugin graph of this *process* (contract.md §2.5): loaded once, then
   * each mount forks a child context from it. Which plugins load is decided by
   * the first mount's selection, because a process has one plugin graph — the
   * selection is a build-level choice, not a per-directory one.
   */
  let host: PluginHost | undefined
  let hostFailure: string | undefined
  let loading: Promise<PluginHost> | undefined
  const pluginHost = (ids: readonly string[], breakPlugin?: string): Promise<PluginHost> => {
    if (loading !== undefined) return loading
    loading = (async () => {
      const created = await createPluginHost(log)
      // `fs` and `git` are kernel services every mount needs (contract.md §3.1, §3.2).
      const halves = await selectPlugins([...new Set(['fs', 'git', ...ids])], breakPlugin)
      const failures = await created.load(halves)
      if (failures.length > 0) {
        hostFailure = failures.map(failure => `${failure.id}: ${failure.message}`).join('; ')
        log(`[diorama] gateway: ${failures.length} plugin(s) failed to load: ${hostFailure}`)
      }
      host = created
      return created
    })()
    return loading
  }

  for (const signal of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(signal, (error: unknown) => {
      // Contract §11: an unattributed error does not kill the gateway; it marks
      // the gateway and is logged. Per-mount errors are attributed at the
      // RPC/HTTP boundaries instead.
      log(`[diorama] gateway: unattributed ${signal}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      gatewayState = 'degraded'
    })
  }

  /** Degraded / recovered → control `events` and the mount's own pages (contract.md §11.1). */
  const states = mounts.onStateChange((mount, previous) => {
    control.emit(mount.state === 'degraded' ? 'degraded' : 'recovered', mount)
    // A page learns about it without polling: the RPC broadcast reaches every
    // connected page of that mount (contract.md §4 broadcast frames).
    mounts.broadcast(mount.mountId, 'mount.state', mount)
    void previous
  })
  /** `onMount` callbacks of a service plugin threw: that plugin failed on that mount. */
  const offMountFailure = onMountFailure((mountId, failure) => {
    mounts.degrade(mountId, failure)
  })

  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    states()
    offMountFailure()
    await control.close().catch(() => {})
    await mounts.close()
    await host?.dispose().catch(() => {})
    rmSync(options.socket, { force: true })
    if (options.pidFile !== undefined) rmSync(options.pidFile, { force: true })
    log('[diorama] gateway stopped')
  }

  const control = createControlServer({
    log,
    async handle(method, params, peer) {
      switch (method) {
        case 'ping':
          return { ...info }
        case 'status':
          return status()
        case 'list':
          return { mounts: mounts.list() }
        case 'mount': {
          const { mount, created } = await mountOne({ mounts, trees, assets, params, log, pluginHost })
          control.emit('mounted', mount.status)
          return { ...mount.status, created, ...(hostFailure === undefined ? {} : { pluginFailures: hostFailure }) }
        }
        case 'unmount': {
          const mountId = typeof params.mountId === 'string' ? params.mountId : undefined
          const root = typeof params.root === 'string' ? params.root : undefined
          if (mountId === undefined && root === undefined) throw coded('EBADREQUEST', 'unmount needs "mountId" or "root"')
          if (mountId !== undefined && mounts.get(mountId) === undefined) {
            return { mountId, root: root ?? '' } // already gone: idempotent (contract.md §7.3)
          }
          if (mountId === undefined && root !== undefined && (await mounts.findByRoot(root)) === undefined) {
            throw coded('ENOMOUNT', `no mount for "${root}"`)
          }
          const removed = await mounts.unmount({
            ...(mountId === undefined ? {} : { mountId }),
            ...(root === undefined ? {} : { root }),
          })
          if (removed === undefined) return { mountId: mountId ?? '', root: root ?? '' }
          trees.delete(removed.mountId)
          control.emit('unmounted', removed)
          return removed
        }
        case 'stop':
          // Answer first: the CLI must see `{ stopping: true }`, then the
          // process drains mounts and exits.
          setTimeout(() => {
            void shutdown().then(() => {
              // The listener is closed; with nothing else open the process exits.
              if (process.getActiveResourcesInfo().length === 0) process.exit(0)
            })
          }, 0)
          return { stopping: true }
        case 'fail': {
          // Test hook (contract.md §11.1 note): make one mount's next work fail,
          // so a degraded transition can be exercised end to end. Only with
          // DIORAMA_TEST_HOOKS=1; off by default and absent from the table.
          if (!testHooks()) throw coded('EMETHOD', `unknown control method "fail"`)
          const mountId = typeof params.mountId === 'string' ? params.mountId : ''
          const failure = new Error(typeof params.message === 'string' ? params.message : 'injected failure')
          mounts.degrade(mountId, failure)
          mounts.broadcast(mountId, 'mount.state', mounts.get(mountId) ?? {})
          return { mountId, state: mounts.get(mountId)?.state ?? 'missing' }
        }
        case 'events': {
          const wanted = Array.isArray(params.topics) ? params.topics.filter(isTopic) : [...CONTROL_TOPICS]
          peer.subscribe(wanted)
          return { subscribed: true }
        }
        default:
          throw coded('EMETHOD', `unknown control method "${method}"`)
      }
    },
  })

  await bindSocket(control, options.socket, log)
  if (options.pidFile !== undefined) writePidFile(options.pidFile, options.socket)
  log(`[diorama] gateway listening on ${options.socket} (pid ${process.pid})`)

  return {
    info,
    socket: control,
    mounts,
    async close() {
      await shutdown()
    },
  }
}

interface MountContext {
  mounts: Gateway
  trees: Map<string, MountTree>
  assets: string
  params: Record<string, unknown>
  log: (message: string) => void
  pluginHost(ids: readonly string[], breakPlugin?: string): Promise<PluginHost>
}

/** Mount one directory: validate, plan, fork its child context, bind its port. */
async function mountOne(context: MountContext): Promise<{ mount: { status: MountStatus }; created: boolean }> {
  const params = parseMountParams(context.params)
  const config = params.config
  // The boot plan validates the plugin selection and the contract range; the
  // client entries are the same for every mount (one build, one plugin set).
  const plan = planPlugins(config.plugins, 'plan', params.root, builtinSource, config)
  const clientEntries = new Map(plan.plugins.map(plugin => [plugin.id, plugin.clientEntry]))
  void context.assets

  return context.mounts.mount({
    root: params.root,
    config,
    ...(params.configFile === undefined ? {} : { configFile: params.configFile }),
    clientEntries,
    manifest: (mountId, port, url): BootManifest => {
      const status = context.mounts.get(mountId)
      return bootManifest(mountId, params, config, port, url, status)
    },
    async boot(mountId, port, url) {
      const host = await context.pluginHost(config.plugins, params.breakPlugin)
      // contract.md §2.5: one fork per mount; `fs` (and `mountId`) live there,
      // the plugin graph itself is shared with every other mount.
      const tree = await forkMount(host, {
        root: params.root,
        mountId,
        config,
        port,
        url,
        ...(params.configFile === undefined ? {} : { configFile: params.configFile }),
        log: message => context.log(`[mount:${mountId}] ${message}`),
      })
      const mountTree: MountTree = {
        dispatcher: guardedDispatcher(mountId, dispatcherFor(tree.ctx as unknown as MountServices), context.mounts),
        dispose: () => tree.dispose(),
      }
      context.trees.set(mountId, mountTree)
      return mountTree
    },
  })
}

/** The parts of a mount's Cordis context the dispatcher reads. */
interface MountServices {
  get(name: string): unknown
}

/** RPC dispatcher of one mount (contract.md §4): only `describe()`d services are proxied. */
function dispatcherFor(mount: MountServices): RpcDispatcher {
  const table = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const name of PROXYABLE) {
      let service: unknown
      try {
        service = mount.get(name)
      } catch {
        service = undefined // the service plugin never activated on this mount
      }
      if (service !== undefined && typeof (service as { describe?: unknown }).describe === 'function') out[name] = service
    }
    return out
  }
  // `table` is the service lookup; the dispatcher's own `services()` method
  // (which lists names) must survive the spread inside `withSubscriptions`.
  return withSubscriptions(createDispatcher(table), table)
}

/** The boot graph of one mount (contract.md §4.1): its URL and configuration source. */
function bootManifest(
  mountId: string,
  params: MountParams,
  config: EffectiveConfig,
  port: number,
  url: string,
  status: MountStatus | undefined,
): BootManifest {
  const plan = planPlugins(config.plugins, mountId, params.root, builtinSource, config)
  return {
    ...plan,
    mountId,
    port,
    url,
    ...(params.configFile === undefined ? {} : { configFile: params.configFile }),
    ...(status === undefined ? {} : { state: status.state === 'degraded' ? 'degraded' : 'ok' }),
    ...(status?.lastError === undefined ? {} : { lastError: status.lastError }),
  }
}

/**
 * Attribute failures to the mount they happened in (contract.md §11): a
 * rejected RPC call marks that mount degraded, and a successful call after it
 * marks it recovered. Unattributed process errors are the gateway's own (§11).
 */
function guardedDispatcher(mountId: string, inner: RpcDispatcher, mounts: Gateway): RpcDispatcher {
  return {
    services: () => inner.services(),
    async call(method, args) {
      try {
        const value = await inner.call(method, args)
        mounts.recover(mountId)
        return value
      } catch (failure) {
        // A rejected call is the plugin's own failure, not a protocol error.
        const code = (failure as { code?: string }).code
        if (code !== 'EMETHOD' && code !== 'ESERVICE' && code !== 'EBADREQUEST') mounts.degrade(mountId, failure)
        throw failure
      }
    },
    async subscribe(method, args, push) {
      const subscribe = inner.subscribe?.bind(inner)
      if (subscribe === undefined) return () => {}
      try {
        const dispose = await subscribe(method, args, payload => {
          try {
            push(payload)
          } catch (failure) {
            mounts.degrade(mountId, failure)
          }
        })
        return () => {
          try {
            dispose()
          } catch (failure) {
            mounts.degrade(mountId, failure)
          }
        }
      } catch (failure) {
        mounts.degrade(mountId, failure)
        throw failure
      }
    },
  }
}

/** Validate `mount` params: the CLI sends what it parsed, nothing more. */
function parseMountParams(params: Record<string, unknown>): MountParams {
  const root = params.root
  const config = params.config
  if (typeof root !== 'string' || root === '') throw coded('EBADREQUEST', 'mount needs a "root" directory')
  if (!isEffectiveConfig(config)) {
    throw coded('EBADREQUEST', 'mount needs a merged "config" (contract.md §4.1: the CLI merges it)')
  }
  return {
    root,
    config,
    ...(typeof params.configFile === 'string' ? { configFile: params.configFile } : {}),
    ...(typeof params.breakPlugin === 'string' ? { breakPlugin: params.breakPlugin } : {}),
  }
}

function isEffectiveConfig(value: unknown): value is EffectiveConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const watch = record.watch as Record<string, unknown> | undefined
  return (
    typeof record.host === 'string' &&
    typeof record.port === 'number' &&
    Array.isArray(record.plugins) &&
    Array.isArray(record.ignore) &&
    watch !== null &&
    typeof watch === 'object' &&
    typeof watch.debounceMs === 'number' &&
    typeof watch.enabled === 'boolean'
  )
}

function coded(code: 'EBADREQUEST' | 'EMETHOD' | 'ENOMOUNT', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/** Whether the contract's test hooks are enabled for this process (contract.md §11.1). */
function testHooks(): boolean {
  return process.env.DIORAMA_TEST_HOOKS === '1'
}

function isTopic(value: unknown): value is ControlTopic {
  return typeof value === 'string' && (CONTROL_TOPICS as readonly string[]).includes(value)
}

/**
 * Bind the control socket. A stale file from a crashed gateway is removed; a
 * live socket is not — whoever answers on it owns the path, and this gateway
 * fails with `EADDRINUSE` (contract.md §7.4).
 */
async function bindSocket(control: ControlServer, path: string, log: (message: string) => void): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  try {
    await control.listen(path)
    return
  } catch (failure) {
    if ((failure as { code?: string }).code !== 'EADDRINUSE') throw failure
  }
  if (await socketIsLive(path)) {
    log(`[diorama] gateway: ${path} is already served by another gateway`)
    throw Object.assign(new Error(`${path} is already in use`), { code: 'EADDRINUSE' })
  }
  log(`[diorama] gateway: removing a stale socket at ${path}`)
  rmSync(path, { force: true })
  await control.listen(path)
}

/** Whether something answers control requests on `path`. */
async function socketIsLive(path: string): Promise<boolean> {
  try {
    const client = await connectControl({ path, log: () => {} })
    client.close()
    return true
  } catch {
    return false
  }
}

/** `{ pid, socket, startedAt }` next to the socket (contract.md §7.4). */
function writePidFile(path: string, socket: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, socket, startedAt: Date.now() }, null, 2)}\n`)
}
