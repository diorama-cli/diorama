/** Server-side entry of the kernel (`diorama-kernel/server`). */
export { buildChangeTree, compareChangeNodes, directoryPaths, type ChangeTreeOptions } from '../shared/changes.ts'
export type {
  ChangeTreeNode,
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
export { SearchService, searchHalf } from './search.ts'
export {
  clipLine,
  compareNameMatches,
  contentMatcher,
  fuzzyMatch,
  isSubsequence,
  looksBinary,
  SEARCH_LINE_MAX_CHARS,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES_PER_FILE,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MAX_SCANNED_FILES,
  type SearchFile,
  type SearchKind,
  type SearchMatch,
  type SearchOptions,
  type SearchResult,
} from '../shared/search.ts'
export {
  DEFAULT_LOG_LIMIT,
  detectRepository,
  findRepoRoot,
  GitRepoView,
  GitService,
  gitEnvironment,
  gitHalf,
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  MAX_LOG_LIMIT,
  openMount,
  parsePorcelainZ,
} from './git.ts'
export {
  DEFAULT_GIT_MAX_DEPTH,
  DEFAULT_GIT_MAX_REPOS,
  discoverRepositories,
  nestedPaths,
  repoRootOf,
  type DiscoveredRepo,
  type DiscoverOptions,
  type DiscoverResult,
} from './repos.ts'
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
export { shellTitle, withShellTitle } from './shell-title.ts'
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
  CONFIG_KEYS,
  GIT_CONFIG_KEYS,
  HTML_CONFIG_KEYS,
  UI_CONFIG_KEYS,
  WATCH_CONFIG_KEYS,
  ConfigError,
  configWritePath,
  defaultConfig,
  dioramaHome,
  formatFileConfig,
  knownKeys,
  loadFileConfig,
  mergeConfig,
  parseConfigFile,
  patchFileConfig,
  readConfigValue,
  readFileConfig,
  resolveConfig,
  validateFileConfig,
  writeFileConfig,
  type ConfigKey,
  type ConfigOrigin,
  type ConfigPatch,
  type EffectiveConfig,
  type FileConfig,
  type HtmlConfigKey,
  type ResolveOptions,
  type UiConfigKey,
  type WatchConfigKey,
} from './config.ts'
export { DEFAULT_THEME_PREFERENCE, THEME_PREFERENCE_PATTERN, type MountConfig } from '../shared/config.ts'
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
  isolateMountService,
  loadPlugins,
  MOUNT_SERVICES,
  mountScope,
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
