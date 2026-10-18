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

/** Props every `file.renderer` entry receives. Renderers never do IO. */
export interface FileRendererProps {
  file: FileInfo
  /** The kernel's pre-read text (absent for binary or oversized files). */
  text?: string
  /** The kernel's pre-read bytes (present when the file is not text). */
  bytes?: Uint8Array
  /** MIME type inferred from the path (contract.md §5.1). */
  mime: string
}
