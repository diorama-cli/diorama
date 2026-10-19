/** Server-side entry of the kernel (`diorama-kernel/server`). */
export type { FsWatchEvent, FileInfo, RelPath, TabInfo } from '../shared/types.ts'
export type { ErrorCode, FsErrorCode, RpcErrorCode } from '../shared/errors.ts'
export type { FileMatcher, FileRendererProps } from '../shared/matcher.ts'
export type { DescribedService, MethodDescriptor, RpcRequest, RpcResponse } from '../shared/rpc.ts'

export { CONTRACT_RANGE, CONTRACT_VERSION, KERNEL_NAME } from '../contract.ts'
export { codedError, fsError, isErrorCode, rpcError } from '../shared/errors.ts'
export { extensionOf, mimeOf } from '../shared/mime.ts'
export { explainMismatch, parseRange, satisfies } from '../shared/semver.ts'

export { FsService, fsHalf, MAX_BINARY_BYTES, MAX_TEXT_BYTES, resolveInside, type FsServiceOptions } from './fs.ts'
export {
  ContractMismatchError,
  HttpError,
  ManifestError,
  PluginLoadError,
  type PluginManifest,
} from './errors.ts'
export { readManifest, type ReadManifestOptions } from './manifest.ts'
export {
  BUILTIN_PLUGIN_IDS,
  BuiltinSource,
  PLUGIN_PREFIX,
  builtinPackageJson,
  builtinSource,
  isBuiltinPluginId,
  kernelPackageDir,
  planPlugins,
  type BootManifest,
  type BuiltinPluginId,
  type PluginPlan,
  type PluginSource,
} from './plan.ts'
export { createMountServer, listen, type MountOptions, type MountServer } from './http.ts'
export {
  CONFIG_FILE,
  ConfigError,
  defaultConfig,
  dioramaHome,
  loadFileConfig,
  mergeConfig,
  parseConfigFile,
  resolveConfig,
  validateFileConfig,
  type ConfigOrigin,
  type EffectiveConfig,
  type FileConfig,
  type ResolveOptions,
} from './config.ts'
export { createIgnore, DEFAULT_IGNORE, type IgnoreRules } from '../shared/ignore.ts'
export { createDispatcher, handleFrame, RpcChannel, RPC_PATH, type RpcDispatcher } from './rpc.ts'
export {
  connectControl,
  createControlServer,
  type ControlClient,
  type ControlClientOptions,
  type ControlPeer,
  type ControlServer,
  type ControlServerOptions,
} from './control.ts'
export {
  CONTROL_PROTOCOL,
  CONTROL_TOPICS,
  controlError,
  frameLine,
  isControlErrorCode,
  MAX_CONTROL_LINE_BYTES,
  parseRequest,
  requestIdOf,
  type ControlErrorCode,
  type ControlRequest,
  type ControlResponse,
  type ControlTopic,
} from '../shared/control.ts'
export type { ControlError } from '../shared/errors.ts'
export {
  bootPlugins,
  createMounts,
  describePlugin,
  loadPlugins,
  pluginProblem,
  type DioramaFace,
  type LoadPluginsResult,
  type MountInfo,
  type Mounts,
  type PluginFailure,
  type ServerTree,
} from './plugins.ts'
