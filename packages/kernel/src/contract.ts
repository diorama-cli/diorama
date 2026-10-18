/** Kernel identity published to plugins as `ctx.diorama`. */
export const KERNEL_NAME = 'diorama'

/**
 * Kernel contract version (contract.md §6). During `0.x` a minor bump is a
 * breaking change: `0.2` replaced the M0 `/api/fs/*` transport with RPC and
 * changed `file.renderer` to the matcher model, so every plugin declares
 * `contract: ">=0.2 <0.3"` and the kernel enforces the range while reading
 * manifests (`server/manifest.ts`).
 */
export const CONTRACT_VERSION = '0.2'

/** What every plugin built against this kernel declares. */
export const CONTRACT_RANGE = '>=0.2 <0.3'
