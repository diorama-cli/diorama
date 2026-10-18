/**
 * Read and validate plugin manifests (`diorama` field, contract.md §1, §6).
 *
 * Every check here is fail loud: a manifest missing `contract` / `id`, an entry
 * outside the package, a client entry this kernel cannot serve, or a contract
 * range the running kernel does not satisfy is a hard failure naming the plugin.
 * The contract check happens *while reading the manifest*, before any half loads.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { CONTRACT_VERSION } from '../contract.ts'
import { satisfies } from '../shared/semver.ts'
import { ContractMismatchError, ManifestError, type PluginManifest } from './errors.ts'

export interface ReadManifestOptions {
  /** Kernel contract version the range must accept. Defaults to `CONTRACT_VERSION`. */
  kernelVersion?: string
  /** Whether a `diorama.server` entry is accepted (contract.md §9). */
  allowServer?: boolean
}

/** Parse and validate the `diorama` field of a plugin package's `package.json`. */
export function readManifest(packageJsonPath: string, options: ReadManifestOptions = {}): PluginManifest {
  const dir = dirname(packageJsonPath)
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  } catch (error) {
    throw new ManifestError(packageJsonPath, `cannot read package.json (${(error as Error).message})`)
  }
  const record = pkg as { name?: unknown; diorama?: Record<string, unknown> }
  const packageName = typeof record.name === 'string' ? record.name : packageJsonPath
  const diorama = record.diorama
  if (diorama === null || typeof diorama !== 'object') {
    throw new ManifestError(packageName, 'missing "diorama" field')
  }
  const fields = diorama as Record<string, unknown>
  const id = requireString(packageName, fields, 'id')
  const contract = requireString(packageName, fields, 'contract')
  const kernelVersion = options.kernelVersion ?? CONTRACT_VERSION
  if (!satisfies(kernelVersion, contract)) {
    throw new ContractMismatchError(id, contract, kernelVersion)
  }
  const manifest: PluginManifest = { package: packageName, dir, contract, id, requires: [] }
  if (typeof fields.displayName === 'string') manifest.displayName = fields.displayName
  if (fields.requires !== undefined) {
    if (!Array.isArray(fields.requires) || fields.requires.some(item => typeof item !== 'string')) {
      throw new ManifestError(packageName, '"diorama.requires" must be an array of plugin ids')
    }
    manifest.requires = [...(fields.requires as string[])]
  }
  if (fields.client !== undefined) {
    manifest.clientEntry = entryOf(packageName, dir, fields.client, 'client')
  }
  if (fields.server !== undefined) {
    if (options.allowServer !== true) {
      throw new ManifestError(packageName, '"diorama.server" halves are not supported by this kernel yet (contract.md §9)')
    }
    manifest.serverEntry = entryOf(packageName, dir, fields.server, 'server')
  }
  if (manifest.clientEntry === undefined && manifest.serverEntry === undefined) {
    throw new ManifestError(packageName, 'declares neither "client" nor "server"; at least one half is required')
  }
  return manifest
}

/** Resolve one half's `entry`, proving the file exists and stays in the package. */
function entryOf(packageName: string, dir: string, half: unknown, label: string): string {
  if (half === null || typeof half !== 'object') {
    throw new ManifestError(packageName, `"diorama.${label}" must be an object`)
  }
  const entry = requireString(packageName, half as Record<string, unknown>, 'entry', `diorama.${label}`)
  const absolute = resolve(dir, entry)
  if (!inside(dir, absolute)) {
    throw new ManifestError(packageName, `"diorama.${label}.entry" must stay inside the package (${entry})`)
  }
  if (!existsSync(absolute)) {
    throw new ManifestError(packageName, `${label} entry "${entry}" does not exist (run "pnpm build")`)
  }
  return absolute
}

function inside(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function requireString(packageName: string, target: Record<string, unknown>, field: string, prefix = ''): string {
  const value = target[field]
  if (typeof value !== 'string' || value === '') {
    const path = prefix === '' ? field : `${prefix}.${field}`
    throw new ManifestError(packageName, `"${path}" must be a non-empty string`)
  }
  return value
}
