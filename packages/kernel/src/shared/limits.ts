/**
 * Size limits of the read-only file service (contract.md §3.1). Shared, not
 * server-only since v0.6: a renderer that fetches bytes itself checks `size`
 * against `MAX_BINARY_BYTES` before asking, and both halves must agree on the
 * number or the renderer shows "too large" for files the server would serve
 * (or asks for files the server refuses).
 */

/** Files up to this size are decoded as UTF-8 by `readText`. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024

/** Files up to this size may be fetched as bytes by `readBytes`. */
export const MAX_BINARY_BYTES = 32 * 1024 * 1024
