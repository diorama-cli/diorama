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
  type BootPlugin,
  type MountHandle,
  type MountInfo,
  type MountManifest,
} from './mount.ts'
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
export { createRpcClient, rpcUrl, RPC_PATH, type RpcClient } from './rpc.ts'
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
export { createTreeService, TreeService, type TreeSnapshot } from './tree.ts'
export { bootClient, provideRecord } from './boot.ts'
export {
  collectCommandContext,
  CommandConflictError,
  CommandsService,
  createCommandsService,
  exclusive,
  isApplePlatform,
  matchesKeys,
  parseKeys,
  type CommandContext,
  type CommandContextSources,
  type CommandSpec,
  type CommandsOptions,
  type CommandsSnapshot,
  type CommandWhen,
  type KeybindingSpec,
  type KeyEventLike,
  type ParsedKeys,
} from './commands.ts'
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
