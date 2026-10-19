/** Server-side entry of the kernel (`diorama-kernel/server`). */
export type {
  DiffEntry,
  DiffResult,
  DiffScope,
  FileInfo,
  FsWatchEvent,
  GitChangeKind,
  GitLogEntry,
  GitStatusEntry,
  RelPath,
  TabInfo,
} from '../shared/types.ts'
export type { ErrorCode, FsErrorCode, RpcErrorCode } from '../shared/errors.ts'
export type { FileMatcher, FileRendererProps } from '../shared/matcher.ts'
export type { DescribedService, MethodDescriptor, RpcRequest, RpcResponse } from '../shared/rpc.ts'

export { CONTRACT_RANGE, CONTRACT_VERSION, KERNEL_NAME } from '../contract.ts'
export { codedError, fsError, gitError, isErrorCode, rpcError } from '../shared/errors.ts'
export { extensionOf, mimeOf } from '../shared/mime.ts'
export { explainMismatch, parseRange, satisfies } from '../shared/semver.ts'

export { FsService, fsHalf, MAX_BINARY_BYTES, MAX_TEXT_BYTES, resolveInside, type FsServiceOptions } from './fs.ts'
export {
  DEFAULT_LOG_LIMIT,
  detectRepository,
  findRepoRoot,
  GitService,
  gitHalf,
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  MAX_LOG_LIMIT,
  parsePorcelainZ,
} from './git.ts'
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
  KERNEL_SERVICE_IDS,
  PLUGIN_PREFIX,
  builtinPackageJson,
  builtinSource,
  isBuiltinPluginId,
  isKernelServiceId,
  kernelPackageDir,
  planPlugins,
  type BootManifest,
  type BuiltinPluginId,
  type KernelServiceId,
  type PluginPlan,
  type PluginSource,
} from './plan.ts'
export { createMountServer, listen, type MountOptions, type MountServer } from './http.ts'
export {
  Gateway,
  MAX_PORT_ATTEMPTS,
  mountUrl,
  newMountId,
  type GatewayMount,
  type GatewayMountInput,
  type GatewayOptions,
  type MountTree,
} from './gateway.ts'
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
  type GatewayInfo,
  type GatewayStatus,
  type MountStatus,
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
  createPluginHost,
  forkMount,
  onMountFailure,
  describePlugin,
  loadPlugins,
  pluginProblem,
  type DioramaFace,
  type LoadPluginsResult,
  type MountInfo,
  type Mounts,
  type MountTree as MountFork,
  type PluginFailure,
  type PluginHost,
  type ServerTree,
} from './plugins.ts'
