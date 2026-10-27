// The client tree's context face (kernel services) is declared once here.
import type {} from './context.ts'

export { buildChangeTree, compareChangeNodes, directoryPaths } from '../shared/changes.ts'
export type {
  BlobResult,
  ChangeTreeNode,
  CommitDetail,
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
export { fsError, gitError, type FsErrorCode, type GitErrorCode } from '../shared/errors.ts'
export { MAX_BINARY_BYTES, MAX_TEXT_BYTES } from '../shared/limits.ts'
export { mimeOf, extensionOf } from '../shared/mime.ts'

export {
  createMountHandle,
  DEFAULT_MOUNT_CONFIG,
  type BootPlugin,
  type MountHandle,
  type MountInfo,
  type MountManifest,
} from './mount.ts'
export type { MountConfig } from '../shared/config.ts'
export { createFsClient, FS_METHODS, type FsClient } from './fs.ts'
export { createGitClient, GIT_METHODS, hasGit, type GitClient } from './git.ts'
export { createSearchClient, SEARCH_METHODS, type SearchClient } from './search.ts'
export {
  clipLine,
  compareNameMatches,
  contentMatcher,
  fuzzyMatch,
  isSubsequence,
  SEARCH_LINE_MAX_CHARS,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES_PER_FILE,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MAX_SCANNED_FILES,
  type FuzzyMatch,
  type SearchFile,
  type SearchKind,
  type SearchMatch,
  type SearchOptions,
  type SearchResult,
} from '../shared/search.ts'
export {
  createRpcClient,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
  rpcUrl,
  RPC_PATH,
  type RpcClient,
  type RpcClientOptions,
} from './rpc.ts'
export {
  browserHistory,
  createRouterService,
  decodeRoute,
  encodeRoute,
  ROUTE_PREFIX,
  type RouteSnapshot,
  type RouterHistory,
  type RouterService,
  type RouterTabs,
} from './router.ts'
export { createTabsService, TabsService, type TabsSnapshot } from './tabs.ts'
export {
  browserThemeHost,
  createThemeService,
  inertThemeHost,
  nextPreference,
  resolveTheme,
  THEME_HASH_KEY,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeDefinition,
  type ThemeHost,
  type ThemePaint,
  type ThemePreference,
  type ThemeScheme,
  type ThemeService,
  type ThemeSnapshot,
} from './theme.ts'
export { createTreeService, TreeService, type TreeReveal, type TreeSnapshot } from './tree.ts'
export { bootClient, provideRecord } from './boot.ts'
export {
  collectCommandContext,
  CommandConflictError,
  CommandsService,
  createCommandsService,
  exclusive,
  type CommandContext,
  type CommandContextSources,
  type CommandSpec,
  type CommandsOptions,
  type CommandsSnapshot,
  type CommandWhen,
  type KeybindingInfo,
  type KeybindingSpec,
} from './commands.ts'
export {
  formatKeys,
  hintOf,
  isApplePlatform,
  matchesKeys,
  modifierOf,
  parseKeys,
  type KeyEventLike,
  type ParsedKeys,
} from './keys.ts'
export { ensureHeldModifierStore, heldModifier, heldModifierStore, holdModifier, type HeldModifier } from './modifiers.ts'
export {
  ensurePageBridge,
  getKernel,
  installKernel,
  pageBridge,
  kernelVersion,
  notifyKernel,
  subscribeKernel,
  type KernelContextValue,
  type KernelPageApi,
  type KernelViews,
  type PageBridge,
} from './page.ts'
export type { BootFailure, BootOptions, BootResult, MountsFace } from './boot.ts'
