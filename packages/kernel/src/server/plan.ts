/**
 * plugin.json — the manifest the browser shell reads to build its plugin graph
 * (architecture.md §11: the boot graph carries `{ baseUrl, mountId, plugins }`).
 * Same shape for `--dump-plan` on the CLI, so what the CLI says it would boot
 * and what the server hands the browser cannot drift.
 *
 * Plugin *sources* are an interface (contract.md §9): M1 ships `BuiltinSource`
 * only. A user-directory or npm source plugs in by implementing `PluginSource`
 * and being handed to `planPlugins`; nothing else in the kernel changes.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT_RANGE, CONTRACT_VERSION, KERNEL_NAME } from '../contract.ts'
import type { EffectiveConfig } from './config.ts'
import { ContractMismatchError, PluginLoadError, type PluginManifest } from './errors.ts'
import { readManifest } from './manifest.ts'

/** Name the built-in package specifiers resolve to (`diorama-plugin-<id>`). */
export const PLUGIN_PREFIX = 'diorama-plugin-'

/**
 * Kernel services that have a server half but no client piece: they are loaded
 * with every mount's tree and never appear in the page's boot graph
 * (contract.md §3.1, §3.2).
 */
export const KERNEL_SERVICE_IDS = ['fs', 'git'] as const

export type KernelServiceId = (typeof KERNEL_SERVICE_IDS)[number]

/** Every built-in plugin, in boot order (client pieces; `fs`/`git` are implied). */
export const BUILTIN_PLUGIN_IDS = [
  'slots',
  'layout',
  'file-tree',
  'tabs',
  'renderer-registry',
  'plaintext',
  'markdown',
  'code',
  'palette',
  'git-changes',
] as const

export type BuiltinPluginId = (typeof BUILTIN_PLUGIN_IDS)[number]

/** Directory holding this kernel's code (`packages/kernel`). */
export function kernelPackageDir(): string {
  return fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
}

/** Path segments that locate built-in plugin packages from the kernel dir. */
const PLUGIN_PATH_SEGMENTS = ['..', 'plugins'] as const

/**
 * Resolve the package.json of a built-in plugin by id.
 * @throws PluginLoadError when the package is not part of this build.
 */
export function builtinPackageJson(id: string): string {
  const packageDir = PLUGIN_PATH_SEGMENTS.reduce((dir, segment) => resolve(dir, segment), kernelPackageDir())
  // Plugin directories are named by their short id (`packages/plugins/<id>`);
  // the package name (`diorama-plugin-<id>`) is read from their manifest.
  const path = resolve(packageDir, id, 'package.json')
  if (!existsSync(path)) {
    throw new PluginLoadError(id, `built-in package ${PLUGIN_PREFIX}${id} is missing (expected at ${path})`)
  }
  return path
}

export function isBuiltinPluginId(id: string): id is BuiltinPluginId {
  return (BUILTIN_PLUGIN_IDS as readonly string[]).includes(id)
}

/** Whether an id names one of the kernel's own server halves (`fs`, `git`). */
export function isKernelServiceId(id: string): id is KernelServiceId {
  return (KERNEL_SERVICE_IDS as readonly string[]).includes(id)
}

/**
 * One way plugins can be found and loaded (contract.md §9). M1 implements the
 * built-in source; a user-directory source is the extension point for later.
 */
export interface PluginSource {
  /** Source name for diagnostics (`'builtin'`, future: `'user-dir'`, `'npm'`). */
  readonly kind: string
  /** Read one plugin's manifest by id. */
  manifest(id: string): PluginManifest
  /** Client-half URL the kernel serves this plugin under. */
  clientUrl(id: string, manifest: PluginManifest): string
}

/** Load one plugin's manifest; contract problems become `PluginLoadError`s. */
function manifestOf(source: PluginSource, id: string): PluginManifest {
  try {
    return source.manifest(id)
  } catch (error) {
    if (error instanceof ContractMismatchError) throw new PluginLoadError(id, error.message)
    throw new PluginLoadError(id, (error as Error).message, { cause: error })
  }
}

/** Content hash of a file: cache key for client halves across ports (architecture.md §10). */
function contentHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
}

/** The `PluginSource` for the packages that ship with this build. */
export class BuiltinSource implements PluginSource {
  readonly kind = 'builtin'

  manifest(id: string): PluginManifest {
    // `fs` ships with the kernel itself: no plugin package, no client half; it
    // exists to provide the server service the other plugins inject.
    if (isKernelServiceId(id)) {
      // Kernel services ship with the kernel itself (no plugin package, no
      // client half): `fs` reads files, `git` reads the repository.
      return {
        package: 'diorama-kernel',
        dir: kernelPackageDir(),
        contract: CONTRACT_RANGE,
        id,
        requires: [],
      }
    }
    if (!isBuiltinPluginId(id)) {
      throw new PluginLoadError(id, `not a built-in plugin (this build knows: ${BUILTIN_PLUGIN_IDS.join(', ')})`)
    }
    const manifest = readManifest(builtinPackageJson(id), { kernelVersion: CONTRACT_VERSION })
    if (manifest.id !== id) {
      throw new PluginLoadError(id, `manifest id is "${manifest.id}", expected "${id}"`)
    }
    if (manifest.clientEntry === undefined) {
      throw new PluginLoadError(id, 'plugins built into this kernel have a client half only')
    }
    return manifest
  }

  clientUrl(id: string, manifest: PluginManifest): string {
    if (manifest.clientEntry === undefined) return ''
    const hash = manifest.clientEntry === undefined ? '' : contentHash(manifest.clientEntry)
    return `/plugins/${id}.js?h=${hash}`
  }
}

export const builtinSource = new BuiltinSource()

/** One plugin row of the boot graph. */
export interface PluginPlan {
  id: string
  /** The plugin's `name` export; the browser verifies the module against it. */
  name: string
  package: string
  displayName?: string
  /** URL path under which the client half is served (content-hashed). */
  clientUrl: string
  /** Absolute path of the bundled client half (server side only). */
  clientEntry: string
  /** Which source produced this plugin (`builtin`, future: `user-dir`). */
  source: string
  /** Infrastructure this plugin needs in the boot graph (contract.md §1). */
  requires: string[]
}

/** The boot graph served to the browser. */
export interface BootManifest {
  kernel: string
  contract: string
  mountId: string
  /** Directory this mount serves (absolute). */
  root: string
  /** The mount's page origin, e.g. `http://127.0.0.1:54321/` (contract.md §7.3). */
  url?: string
  /** The port `url` names. */
  port?: number
  /** The `diorama.toml` the configuration came from; absent = defaults (contract.md §4.1). */
  configFile?: string
  /** Whether this mount is healthy (contract.md §11.1); the page shows a banner when not. */
  state?: 'ok' | 'degraded'
  /** Why the mount is degraded. */
  lastError?: { code?: string; message: string; at: number }
  /** Effective configuration (contract.md §4.1); absent in `--dump-plan`-less contexts. */
  config?: EffectiveConfig
  plugins: PluginPlan[]
}

/**
 * Validate a plugin selection (ids) and produce the boot manifest.
 *
 * Consecutive duplicates are ignored; the order of first appearance is the
 * boot order. `requires` is recorded for the client loader, which completes the
 * graph with infrastructure pieces (e.g. a renderer needs `slots`).
 *
 * @throws PluginLoadError when an id is unknown, its manifest is invalid, or
 *   its contract range rejects the kernel.
 */
export function planPlugins(
  ids: readonly string[],
  mountId: string,
  root: string,
  source: PluginSource = builtinSource,
  config?: EffectiveConfig,
): BootManifest {
  const seen = new Set<string>()
  const known = new Map<string, PluginManifest>()
  const plugins: PluginPlan[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const manifest = manifestOf(source, id)
    // A server-only plugin still has to be loaded on the server side; it just
    // contributes no row to the browser's boot graph (contract.md §1).
    if (manifest.clientEntry !== undefined) {
      plugins.push({
        id,
        name: id,
        package: manifest.package,
        ...(manifest.displayName === undefined ? {} : { displayName: manifest.displayName }),
        clientUrl: source.clientUrl(id, manifest),
        clientEntry: manifest.clientEntry,
        source: source.kind,
        requires: manifest.requires,
      })
    }
    known.set(id, manifest)
  }
  for (const row of plugins) {
    for (const required of row.requires) {
      if (!known.has(required)) {
        throw new PluginLoadError(row.id, `requires "${required}", which is not in this plugin selection (select the plugin that provides it)`)
      }
    }
  }
  return {
    kernel: KERNEL_NAME,
    contract: CONTRACT_VERSION,
    mountId,
    root,
    ...(config === undefined ? {} : { config }),
    plugins,
  }
}
