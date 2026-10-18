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

/**
 * A plugin whose `contract` range does not accept the running kernel
 * (contract.md §6). Raised while reading the manifest, before any half loads.
 */
export class ContractMismatchError extends Error {
  constructor(
    readonly id: string,
    readonly required: string,
    readonly provided: string,
  ) {
    super(`plugin "${id}" is incompatible with this kernel: requires contract ${required}, kernel provides ${provided}`)
    this.name = 'ContractMismatchError'
  }
}

/** A plugin that cannot be honored (e.g. missing bundled client entry). */
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
  /** Contract range declared by the plugin, e.g. `>=0.2 <0.3`. */
  contract: string
  /** Short, globally unique id. */
  id: string
  displayName?: string
  /** Entry file of the client half, absolute. */
  clientEntry?: string
  /** Entry file of the server half, absolute. */
  serverEntry?: string
  /** Infrastructure this plugin needs in the boot graph (contract.md §1). */
  requires: string[]
}
