/**
 * The `file.renderer` entry contract (contract.md §5.1). Lives in the shared
 * layer (no React, no Cordis) so the kernel's page handle can type it without
 * importing a plugin, and renderer pieces depend on the types alone.
 */
import type { FileInfo } from './types.ts'

/** How a renderer claims a file (contract.md §5.1). */
export type FileMatcher =
  | { ext: string[] }
  | { mime: string[] }
  | { probe: (head: Uint8Array, file: FileInfo, mime: string) => boolean; cost?: 'cheap' | 'expensive' }

/**
 * Props every `file.renderer` entry receives (contract.md §5.1).
 *
 * The kernel pre-reads **text only** (v0.6): a renderer that needs bytes of
 * its own (images, PDFs) calls `mountCtx.fs.readBytes` after a `stat`, and
 * skips the request when the file is larger than `MAX_BINARY_BYTES`.
 */
export interface FileRendererProps {
  file: FileInfo
  /** The kernel's pre-read text (absent for binary or oversized files). */
  text?: string
  /** MIME type inferred from the path (contract.md §5.1). */
  mime: string
}
