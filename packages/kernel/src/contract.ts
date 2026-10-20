/** Kernel identity published to plugins as `ctx.diorama`. */
export const KERNEL_NAME = 'diorama'

/**
 * Kernel contract version (contract.md §6). During `0.x` a minor bump is a
 * breaking change. `0.3` gave tabs a real multi-tab model, `ctx.commands`,
 * `layout.overlay`, ignore-aware `fs.list`, RPC event `session`s and
 * `diorama.toml` (contract §13). `0.4` turns one foreground process into a
 * gateway serving many directories: one root context, per-directory fork
 * contexts (`ctx.fork()`), an HTTP port per mount, the control plane of
 * contract §7, `watch` sharing with a per-mount cap, and `mount.state` /
 * `degraded` (contract §14). `0.5` adds the read-only git view (`ctx.git`,
 * contract §3.2), the URL router (`ctx.router`, §3.8) and `sidebar.views`
 * (replacing `sidebar.tree`, §5.2). `0.6` adds the git history view: `show` /
 * `showCommit` / `blob` on `ctx.git`, `DiffScope.base` widened to `'index'`
 * or a commit, the `history` sidebar view with `seats.git-commit`, the image
 * and PDF renderers, the `image/*` mime wildcard, and a renderer registry
 * that only pre-reads text (§16). `0.7` makes `layout.overlay` a **list** seat
 * so more than one command surface can live there (the palette and the new
 * shortcut sheet, `help`), and names the page-global store those overlays use
 * to take turns (`diorama-ui/overlay`). `0.8` adds file search: `ctx.search`
 * (`name` / `content`, contract §3.9) as a kernel service every mount
 * provides, the `search` sidebar view and the quick-open overlay of the
 * `search` piece, and the `diorama-ui` reveal store that carries a hit's line
 * from the result list to the renderer (§3.9, §5.2). Every plugin declares
 * `contract: ">=0.8 <0.9"`, enforced while reading manifests
 * (`server/manifest.ts`).
 */
export const CONTRACT_VERSION = '0.8'

/** What every plugin built against this kernel declares. */
export const CONTRACT_RANGE = '>=0.8 <0.9'
