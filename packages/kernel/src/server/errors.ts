/** Errors shared by the server halves of the kernel. */

export class HttpError extends Error {
  readonly status: number
  readonly code: 'ENOENT' | 'EISDIR' | 'EBADPATH' | 'EBADREQUEST'

  constructor(status: number, code: HttpError['code'], message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** A manifest that does not satisfy contract.md §1. */
export class ManifestError extends Error {
  constructor(
    readonly packageName: string,
    readonly reason: string,
  ) {
    super(`plugin "${packageName}" has an invalid manifest: ${reason}`)
    this.name = 'ManifestError'
  }
}

/** A built-in plugin that cannot be honored (e.g. missing bundled client entry). */
export class PluginLoadError extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`plugin "${id}": ${reason}`, options)
    this.name = 'PluginLoadError'
  }
}

/** Validated subset of a plugin package's `diorama` manifest field. */
export interface PluginManifest {
  /** Package name, e.g. `diorama-plugin-plaintext`. */
  package: string
  /** Package directory (absolute). */
  dir: string
  /** Contract range declared by the plugin, e.g. `>=0.1 <0.2`. */
  contract: string
  /** Short, globally unique id. */
  id: string
  displayName?: string
  /** Entry file of the client half, absolute. */
  clientEntry?: string
}
