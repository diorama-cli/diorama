/**
 * Type-only entry of the kernel (`diorama-kernel`, the package root).
 *
 * Types that plugins and pieces reference — `FileInfo`, `MountHandle`, … —
 * resolve here without the Cordis runtime: no `cordis` import, no module
 * augmentation. That keeps a package's declarations independent of which
 * Cordis environment (server or browser) its consumer compiles under. Service
 * faces (`ctx.tabs`, `ctx.slots`, …) augment `cordis` in the runtime module
 * that provides them; a plugin gets those by importing that module.
 */
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
} from './shared/types.ts'
export type { ErrorCode, FsErrorCode, GitErrorCode, RpcErrorCode } from './shared/errors.ts'
export type { BootPlugin, MountHandle, MountInfo, MountManifest } from './client/mount.ts'
export type { FsClient } from './client/fs.ts'
export type { GitClient } from './client/git.ts'
export type { RpcClient } from './client/rpc.ts'
export type { FileMatcher, FileRendererProps } from './shared/matcher.ts'
export type {
  SearchFile,
  SearchKind,
  SearchMatch,
  SearchOptions,
  SearchResult,
} from './shared/search.ts'
export type { DescribedService, MethodDescriptor } from './shared/rpc.ts'
export { ROUTE_PREFIX } from './shared/types.ts'
export { mimeOf, extensionOf } from './shared/mime.ts'
export type { TabsSnapshot } from './client/tabs.ts'
export type { TreeSnapshot } from './client/tree.ts'
export type { BootFailure, BootOptions, BootResult, MountsFace } from './client/boot.ts'
