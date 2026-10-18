/**
 * The `file.renderer` entry contract (contract.md §5, docs/m0/spec.md §1).
 * Kept in its own module so renderer pieces can depend on the types alone.
 */
import type { FileInfo, MountHandle } from 'diorama-kernel/client'

/** Props every `file.renderer` entry receives. Renderers never do IO. */
export interface FileRendererProps {
  file: FileInfo
  content: Uint8Array
  mountCtx: MountHandle
}
