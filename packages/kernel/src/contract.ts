/** Kernel identity published to plugins as `ctx.diorama`. */
export const KERNEL_NAME = 'diorama'

/**
 * M0 contract version. contract.md §6: during `0.x`, a minor bump is a
 * breaking change, so M0 plugins declare `contract: ">=0.1 <0.2"`.
 * M0 does not enforce the range yet (plan.md: contract version check is M1);
 * the field is required so plugin manifests are already shaped correctly.
 */
export const CONTRACT_VERSION = '0.1'
