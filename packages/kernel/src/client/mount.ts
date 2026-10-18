/**
 * The page handle: `{ mountId, root, baseUrl, fs }`, one per browser page.
 *
 * Client pieces and the renderer are separate builds, each carrying its own
 * copy of this module; the handle itself travels through the page bridge, so
 * nothing here is shared module state (docs/m0/spec.md §10.3).
 */
import { createFsClient, type FsClient } from './fs.ts'

export interface BootPlugin {
  id: string
  /** Name the plugin declares; compared with the module's `name` export. */
  name: string
  clientUrl: string
}

export interface MountInfo {
  mountId: string
  /** Absolute directory as the server sees it. */
  root: string
  /** Origin of the server: `http://127.0.0.1:1234`. */
  baseUrl: string
}

/** What the browser shell reads from `/plugin.json`. */
export interface MountManifest extends MountInfo {
  kernel: string
  plugins: BootPlugin[]
}

export interface MountHandle extends MountInfo {
  fs: FsClient
}

/** Build the page handle from the boot manifest. */
export function createMountHandle(manifest: MountManifest): MountHandle {
  const baseUrl = manifest.baseUrl.replace(/\/$/, '')
  return {
    mountId: manifest.mountId,
    root: manifest.root,
    baseUrl,
    fs: createFsClient(baseUrl),
  }
}
