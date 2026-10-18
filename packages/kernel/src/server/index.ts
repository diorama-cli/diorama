/** Type-only re-exports: the kernel package root is `src/types.ts`. */
export type { FileInfo, RelPath, TabInfo } from '../shared/types.ts'
export type { FsErrorCode } from '../shared/errors.ts'

export { KERNEL_NAME, CONTRACT_VERSION } from '../contract.ts'
export { fsError, FS_HTTP_STATUS } from '../shared/errors.ts'

export { FsService, MAX_TEXT_BYTES, resolveInside } from './fs.ts'
export { HttpError, ManifestError, PluginLoadError, type PluginManifest } from './errors.ts'
export { readManifest } from './manifest.ts'
export {
  BUILTIN_PLUGIN_IDS,
  PLUGIN_PREFIX,
  builtinPackageJson,
  isBuiltinPluginId,
  kernelPackageDir,
  planPlugins,
  type BootManifest,
  type BuiltinPluginId,
  type PluginPlan,
} from './plan.ts'
export { createMountServer, listen, type MountOptions } from './http.ts'
export {
  bootPlugins,
  describePlugin,
  loadPlugins,
  pluginProblem,
  type PluginFailure,
  type ServerTree,
} from './plugins.ts'
