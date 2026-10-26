/** Kernel identity published to plugins as `ctx.diorama`. */
export const KERNEL_NAME = 'diorama'

/**
 * Kernel contract version (contract.md §6).
 *
 * **`0.0.x` is the pre-1.0 line**: the history below is what each milestone
 * settled, but the *number* restarts at `0.0.1` for the first publish, and a
 * bump to the next `0.0.x` is what a breaking change looks like until the
 * surface stabilises. Plugins declare a narrow range
 * (`>=0.0.5 <0.1.0`), so a published kernel never loads a piece built against
 * a different line.
 *
 * What the line contains today (contract §13–§20): the multi-tab model,
 * `ctx.commands`, `layout.overlay` as a **list** seat, ignore-aware `fs.list`,
 * RPC event sessions and `diorama.toml`; the gateway with one root context and
 * per-directory fork contexts (`ctx.fork()`), an HTTP port per mount, the
 * control plane (§7), `watch` sharing with a per-mount cap and `mount.state` /
 * `degraded`; the read-only git view (`ctx.git`, §3.2), the URL router
 * (`ctx.router`, §3.8) and `sidebar.views` (§5.2); the git history view
 * (`show` / `showCommit` / `blob`, `DiffScope.base`), the image and PDF
 * renderers and the `image/*` mime wildcard; the shortcut sheet (`help`); file
 * search (`ctx.search`, §3.9) with the `search` view and quick open; the icon
 * tables of `diorama-ui` (docs/m7/spec.md); and the colour scheme
 * (`ctx.theme`, §3.10) with the token palette of `diorama-ui/styles.css`
 * (docs/m9/spec.md).
 */
export const CONTRACT_VERSION = '0.0.5'

/** What every plugin built against this kernel declares. */
export const CONTRACT_RANGE = '>=0.0.5 <0.1.0'
