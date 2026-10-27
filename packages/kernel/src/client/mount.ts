/**
 * The page handle: `{ mountId, root, baseUrl, fs }`, one per browser page.
 *
 * Client pieces and the renderer are separate builds, each carrying its own
 * copy of this module; the handle itself travels through the page bridge, so
 * nothing here is shared module state (docs/m0/spec.md §10.3).
 */
import { DEFAULT_THEME_PREFERENCE, type MountConfig } from '../shared/config.ts'
import { createFsClient, type FsClient } from './fs.ts'
import { createGitClient, type GitClient } from './git.ts'
import { createRpcClient, rpcUrl, type RpcClient } from './rpc.ts'
import { createSearchClient, type SearchClient } from './search.ts'

export interface BootPlugin {
  id: string
  /** Name the plugin declares; compared with the module's `name` export. */
  name: string
  clientUrl: string
  /** Infrastructure pieces the loader must keep in the graph (contract.md §1). */
  requires?: string[]
  /** Which plugin source produced it (`builtin`, future: `user-dir`). */
  source?: string
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
  /** Kernel contract version; checked against the shell's build. */
  contract?: string
  /**
   * The mount's effective configuration (contract.md §4.1). The server sends
   * the whole `EffectiveConfig`; the page reads the slice in `MountConfig`.
   */
  config?: MountConfig
  plugins: BootPlugin[]
}

export interface MountHandle extends MountInfo {
  /** The mount's files, through RPC (contract.md §3.1). */
  fs: FsClient
  /**
   * The mount's repositories, through RPC (contract.md §3.2). Calls reject with
   * `ESERVICE` when the directory holds no git repository at all; ask
   * `hasGit()` (from `diorama-kernel/client`) before relying on it.
   */
  git: GitClient
  /**
   * Search the mount by name or content (contract.md §3.9). The service comes
   * from the `search` piece; on a mount without it every call rejects with
   * `ESERVICE` (the piece that renders results is the one that registers it,
   * so a page that shows search always has it).
   */
  search: SearchClient
  /**
   * The mount's configuration as the page sees it (contract.md §4.1): the
   * fields a piece may act on. Read-only; defaults apply when the server sent
   * none (a unit test, an older `/plugin.json`).
   */
  config: MountConfig
  /** The RPC channel: escape hatch plus event subscription (contract.md §4). */
  rpc: RpcClient
}

/** The page's defaults, matching `defaultConfig()` on the server (contract.md §4.1). */
export const DEFAULT_MOUNT_CONFIG: MountConfig = {
  html: { scripts: false },
  ui: { theme: DEFAULT_THEME_PREFERENCE },
}

/** Build the page handle from the boot manifest. */
export function createMountHandle(manifest: MountManifest): MountHandle {
  const baseUrl = manifest.baseUrl.replace(/\/$/, '')
  const rpc = createRpcClient({ url: rpcUrl(baseUrl) })
  return {
    mountId: manifest.mountId,
    root: manifest.root,
    baseUrl,
    fs: createFsClient(rpc),
    git: createGitClient(rpc),
    search: createSearchClient(rpc),
    // Copied, not shared: a piece must not be able to edit the page's defaults
    // by writing to the handle.
    config: {
      html: { scripts: manifest.config?.html?.scripts ?? DEFAULT_MOUNT_CONFIG.html.scripts },
      ui: { theme: manifest.config?.ui?.theme ?? DEFAULT_MOUNT_CONFIG.ui.theme },
    },
    rpc,
  }
}
