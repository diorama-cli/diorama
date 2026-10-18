// The client tree's context face (kernel services) is declared once here.
import type {} from './context.ts'

export type { FileInfo, RelPath, TabInfo } from '../shared/types.ts'
export { fsError, type FsErrorCode } from '../shared/errors.ts'

export {
  createMountHandle,
  type BootPlugin,
  type MountHandle,
  type MountInfo,
  type MountManifest,
} from './mount.ts'
export { createFsClient, type FsClient } from './fs.ts'
export { createTabsService, TabsService, type TabsSnapshot } from './tabs.ts'
export { createTreeService, TreeService, type TreeSnapshot } from './tree.ts'
export { bootClient, provideRecord } from './boot.ts'
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
