// The client tree's context face (kernel services) is declared once here.
import type {} from './context.ts'

export type { FsWatchEvent, FileInfo, RelPath, TabInfo } from '../shared/types.ts'
export { fsError, type FsErrorCode } from '../shared/errors.ts'

export {
  createMountHandle,
  type BootPlugin,
  type MountHandle,
  type MountInfo,
  type MountManifest,
} from './mount.ts'
export { createFsClient, FS_METHODS, type FsClient } from './fs.ts'
export { createRpcClient, rpcUrl, RPC_PATH, type RpcClient } from './rpc.ts'
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
