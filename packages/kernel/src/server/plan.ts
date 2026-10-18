/**
 * plugin.json — the manifest the browser shell reads to build its plugin graph
 * (architecture.md §11: the boot graph carries `{ baseUrl, mountId, plugins }`).
 * Same shape for `--dump-plan` on the CLI, so what the CLI says it would boot
 * and what the server hands the browser cannot drift.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KERNEL_NAME } from '../contract.ts'
import { PluginLoadError } from './errors.ts'
import { readManifest } from './manifest.ts'

/** Name the built-in package specifiers resolve to (`diorama-plugin-<id>`). */
export const PLUGIN_PREFIX = 'diorama-plugin-'

/** Every built-in plugin, in boot order. M0 = this fixed list. */
export const BUILTIN_PLUGIN_IDS = ['slots', 'layout', 'file-tree', 'tabs', 'renderer-registry', 'plaintext'] as const

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
  const packageDir = PLUGIN_PATH_SEGMENTS.reduce(
    (dir, segment) => resolve(dir, segment),
    kernelPackageDir(),
  )
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

/** One plugin row of the boot graph. */
export interface PluginPlan {
  id: string
  /** The plugin's `name` export; the browser verifies the module against it. */
  name: string
  package: string
  displayName?: string
  /** URL path under which the client half is served. */
  clientUrl: string
  /** Absolute path of the bundled client half (server side only). */
  clientEntry: string
}

/** The boot graph served to the browser. */
export interface BootManifest {
  kernel: string
  mountId: string
  /** Display root of the mount; the browser fills in the url host/port itself. */
  root: string
  plugins: PluginPlan[]
}

/**
 * Validate a plugin selection (ids) and produce the boot manifest.
 * @throws PluginLoadError when an id is unknown or its manifest is invalid.
 */
export function planPlugins(ids: readonly string[], mountId: string, root: string): BootManifest {
  const seen = new Set<string>()
  const plugins = ids.map((id): PluginPlan => {
    if (seen.has(id)) throw new PluginLoadError(id, 'listed twice in the plugin list')
    seen.add(id)
    if (!isBuiltinPluginId(id)) {
      throw new PluginLoadError(id, `not a built-in plugin (M0 knows: ${BUILTIN_PLUGIN_IDS.join(', ')})`)
    }
    const packageJson = builtinPackageJson(id)
    if (!existsSync(packageJson)) {
      throw new PluginLoadError(id, `package.json not found at ${packageJson}`)
    }
    let manifest
    try {
      manifest = readManifest(packageJson)
    } catch (error) {
      throw new PluginLoadError(id, (error as Error).message, { cause: error })
    }
    if (manifest.id !== id) {
      throw new PluginLoadError(id, `manifest id is "${manifest.id}", expected "${id}"`)
    }
    if (manifest.clientEntry === undefined) {
      throw new PluginLoadError(id, 'has no client half; M0 has no server-only plugins')
    }
    return {
      id,
      name: id,
      package: manifest.package,
      ...(manifest.displayName === undefined ? {} : { displayName: manifest.displayName }),
      clientUrl: `/plugins/${id}.js`,
      clientEntry: manifest.clientEntry,
    }
  })
  return { kernel: KERNEL_NAME, mountId, root, plugins }
}
