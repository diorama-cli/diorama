/**
 * Read and validate built-in plugin manifests (`diorama` field, contract.md §1, §6).
 * M0 does not load external plugins; the checks here are the shape M1's loader
 * reuses. A manifest missing `contract` / `id`, or declaring an entry file (or
 * server half) this kernel cannot honor, is a hard failure (fail loud).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ManifestError, type PluginManifest } from './errors.ts'

/** Parse and validate the `diorama` field of a plugin package's `package.json`. */
export function readManifest(packageJsonPath: string): PluginManifest {
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
  const manifest: PluginManifest = {
    package: packageName,
    dir,
    contract: requireString(packageName, diorama, 'contract'),
    id: requireString(packageName, diorama, 'id'),
  }
  if (typeof diorama.displayName === 'string') manifest.displayName = diorama.displayName

  const record2 = diorama as Record<string, unknown>
  const client = record2.client
  if (client !== undefined) {
    if (client === null || typeof client !== 'object') {
      throw new ManifestError(packageName, '"diorama.client" must be an object')
    }
    const entry = requireString(packageName, client as Record<string, unknown>, 'entry')
    const absolute = isAbsolute(entry) ? entry : join(dir, entry)
    if (!existsSync(absolute)) {
      throw new ManifestError(packageName, `client entry "${entry}" does not exist (run "pnpm build")`)
    }
    manifest.clientEntry = absolute
  }
  if (record2.server !== undefined) {
    throw new ManifestError(packageName, '"diorama.server" halves are not supported by this kernel')
  }
  return manifest
}

function requireString(packageName: string, target: Record<string, unknown>, field: string): string {
  const value = target[field]
  if (typeof value !== 'string' || value === '') {
    throw new ManifestError(packageName, `"${field}" must be a non-empty string`)
  }
  return value
}
