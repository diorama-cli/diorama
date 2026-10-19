/** Kernel identity published to plugins as `ctx.diorama`. */
export const KERNEL_NAME = 'diorama'

/**
 * Kernel contract version (contract.md §6). During `0.x` a minor bump is a
 * breaking change: `0.3` gave tabs a real multi-tab model (`TabInfo.path`
 * replaces the `FileInfo` snapshot, `tabs.content` is keyed by tab id), added
 * the `ctx.commands` model and the `layout.overlay` seat, made `fs.list`
 * honour the ignore rules, gave RPC events a `session` for subscriptions, and
 * added `diorama.toml` (contract §13). Every plugin declares
 * `contract: ">=0.3 <0.4"`, enforced while reading manifests
 * (`server/manifest.ts`).
 */
export const CONTRACT_VERSION = '0.3'

/** What every plugin built against this kernel declares. */
export const CONTRACT_RANGE = '>=0.3 <0.4'
