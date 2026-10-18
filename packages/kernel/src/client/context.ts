/**
 * The client tree's context face, declared once for every client piece.
 *
 * Client pieces are separate builds: each carries its own copy of the Cordis
 * declarations, so `ctx.tabs` typed in one piece would be invisible to another.
 * The faces of the kernel-owned services are declared here, in the one module
 * every piece and the renderer carry a copy of.
 */
import type { FsClient } from './fs.ts'
import type { TabsService } from './tabs.ts'
import type { TreeService } from './tree.ts'

declare module 'cordis' {
  interface Context {
    /** The page handle (`mountCtx`): `{ mountId, root, baseUrl, fs }`. */
    mount: import('./mount.ts').MountHandle
    /** Open / switch tabs — provided by the `tabs` piece. */
    tabs: TabsService
    /** Navigation state of the left column — provided by the `file-tree` piece. */
    tree: TreeService
  }
}

export type { FsClient, TabsService, TreeService }
