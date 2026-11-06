/**
 * Client half of `ctx.lsp` (contract.md §3.12, §4): the read-only language
 * intelligence of a mount, obtained through the RPC proxy.
 *
 * Optional by contract: a mount with no language server, or a file whose
 * language nobody claims, has no answers — so callers ask `status()` first and
 * treat an empty answer as "no jump here", never as an error to show.
 */
import type { LspHover, LspLocation, LspPosition, LspServerInfo, LspSymbol } from '../shared/lsp.ts'
import type { RelPath } from '../shared/types.ts'
import type { RpcClient } from './rpc.ts'

/** The proxyable methods of the server's `LspService`. */
export const LSP_METHODS = ['status', 'definition', 'typeDefinition', 'references', 'hover', 'documentSymbol'] as const

export interface LspClient {
  /** Which server this mount would use, and whether it is usable. */
  status(): Promise<LspServerInfo[]>
  /** Where a symbol at `position` is declared. */
  definition(path: RelPath, position: LspPosition, text?: string): Promise<LspLocation[]>
  /** Where its type is declared. */
  typeDefinition(path: RelPath, position: LspPosition, text?: string): Promise<LspLocation[]>
  /** Every place it is used. */
  references(path: RelPath, position: LspPosition, text?: string): Promise<LspLocation[]>
  /** The hover card's contents, when there is one. */
  hover(path: RelPath, position: LspPosition, text?: string): Promise<LspHover | undefined>
  /** The file's outline. */
  documentSymbol(path: RelPath, text?: string): Promise<LspSymbol[]>
}

/** Build the `mountCtx.lsp` face over the RPC channel. */
export function createLspClient(rpc: RpcClient): LspClient {
  const remote = rpc.service<LspClient>('lsp', LSP_METHODS)
  return {
    status: () => remote.status(),
    definition: (path, position, text) =>
      text === undefined ? remote.definition(path, position) : remote.definition(path, position, text),
    typeDefinition: (path, position, text) =>
      text === undefined ? remote.typeDefinition(path, position) : remote.typeDefinition(path, position, text),
    references: (path, position, text) =>
      text === undefined ? remote.references(path, position) : remote.references(path, position, text),
    hover: (path, position, text) =>
      text === undefined ? remote.hover(path, position) : remote.hover(path, position, text),
    documentSymbol: (path, text) => (text === undefined ? remote.documentSymbol(path) : remote.documentSymbol(path, text)),
  }
}

/**
 * Whether this mount has any usable language server, without throwing when it
 * has none: a `status()` call rejects with `ESERVICE` when no service was provided.
 */
export async function hasLsp(lsp: LspClient): Promise<boolean> {
  try {
    const servers = await lsp.status()
    return servers.some(server => server.state === 'running' || server.state === 'installing')
  } catch (error) {
    if ((error as { code?: string }).code === 'ESERVICE') return false
    throw error
  }
}
