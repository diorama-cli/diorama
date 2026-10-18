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
export type { FileInfo, RelPath, TabInfo } from './shared/types.ts'
export type { FsErrorCode } from './shared/errors.ts'
export type { BootPlugin, MountHandle, MountInfo, MountManifest } from './client/mount.ts'
export type { FsClient } from './client/fs.ts'
export type { TabsSnapshot } from './client/tabs.ts'
export type { TreeSnapshot } from './client/tree.ts'
export type { BootFailure, BootOptions, BootResult, MountsFace } from './client/boot.ts'
