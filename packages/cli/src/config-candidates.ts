/**
 * Candidate lists for the interactive wizard (contract.md §4.2).
 *
 * A candidate is a **shortcut, never a restriction**: every list is offered as
 * numbered options, and anything typed that is not a number is taken as the
 * literal value. The lists exist to save typing (an IPv4 address is 12 keys and
 * easy to get wrong), not to validate — validation stays with the kernel's
 * `validateFileConfig`, which is the only thing that decides whether a value
 * may be written.
 *
 * Everything here is a pure function of injected inputs (`interfaces`, the
 * current config): no test touches a real network card.
 */
import type { FileConfig } from 'diorama-kernel/server'

/** One offered value. `detail` is the right-hand annotation, if any. */
export interface Candidate {
  /** What gets written when this candidate is chosen. */
  value: string
  /** Left column: the value as shown (defaults to `value`). */
  label?: string
  /** Right column: why it is on the list. */
  detail?: string
  /** Marked as the recommended/default choice. */
  recommended?: boolean
}

/** The subset of `os.NetworkInterfaceInfo` this module needs. */
export interface InterfaceInfo {
  address: string
  family: string
  internal: boolean
}

/** `os.networkInterfaces()`, narrowed. */
export type InterfaceMap = Record<string, InterfaceInfo[] | undefined>

/**
 * Addresses worth offering for `host`.
 *
 * Order: loopback (the default), then "every interface", then each **external
 * IPv4** with the interface that carries it, then "every IPv6 interface".
 *
 * Link-local IPv6 (`fe80::/10`) is left out on purpose: an URL for it needs a
 * zone id (`[fe80::1%en0]`), so a `diorama.toml` carrying one does not travel
 * to another machine, and `::` already covers "all IPv6 interfaces".
 */
export function hostCandidates(interfaces: InterfaceMap, current?: string): Candidate[] {
  const candidates: Candidate[] = [
    { value: '127.0.0.1', detail: 'this machine only (loopback)', recommended: true },
    { value: '0.0.0.0', detail: 'every IPv4 interface — reachable on the network' },
  ]
  const external = externalIPv4(interfaces)
  for (const { address, name } of external) {
    candidates.push({ value: address, detail: name })
  }
  const hasExternalV6 = externalIPv6(interfaces).length > 0
  if (hasExternalV6) candidates.push({ value: '::', detail: 'every IPv6 interface' })
  // A value from the file that is not on the machine any more stays visible:
  // the reader must see what will be written, even if it cannot work here.
  if (current !== undefined && current !== '' && !candidates.some(candidate => candidate.value === current)) {
    candidates.push({ value: current, detail: 'current value (not an address on this machine)' })
  }
  return candidates
}

/** Non-internal IPv4 addresses, in interface order, de-duplicated. */
export function externalIPv4(interfaces: InterfaceMap): { address: string; name: string }[] {
  const seen = new Set<string>()
  const out: { address: string; name: string }[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (seen.has(entry.address)) continue
      seen.add(entry.address)
      out.push({ address: entry.address, name })
    }
  }
  return out
}

/** Non-internal, non-link-local IPv6 addresses. */
export function externalIPv6(interfaces: InterfaceMap): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv6' || entry.internal) continue
      if (entry.address.toLowerCase().startsWith('fe80:')) continue
      out.push({ address: entry.address, name })
    }
  }
  return out
}

/** Whether an address is reachable from other machines (worth a warning). */
export function isExposed(host: string): boolean {
  const value = host.trim()
  if (value === '0.0.0.0' || value === '::' || value === '::0') return true
  // Anything that is not loopback is reachable if the machine routes to it.
  return value !== '127.0.0.1' && value !== 'localhost' && value !== '::1'
}

/**
 * Patterns offered for `ignore`. The first two are the contract defaults; the
 * rest are the build/cache directories of the ecosystems this viewer sees most.
 */
export const IGNORE_CANDIDATES: readonly Candidate[] = [
  { value: '.git', detail: 'default', recommended: true },
  { value: 'node_modules', detail: 'default', recommended: true },
  { value: 'dist', detail: 'build output' },
  { value: 'build', detail: 'build output' },
  { value: 'target', detail: 'Rust / Maven' },
  { value: 'coverage', detail: 'test reports' },
  { value: '.next', detail: 'Next.js' },
  { value: '__pycache__', detail: 'Python' },
  { value: '.venv', detail: 'Python' },
  { value: '*.log', detail: 'logs' },
  { value: '.DS_Store', detail: 'macOS' },
]

/** Every built-in piece, as a plugin candidate (the list is a parameter: the CLI knows it). */
export function pluginCandidates(ids: readonly string[], current?: readonly string[]): Candidate[] {
  const chosen = new Set(current ?? [])
  return ids.map(id => ({
    value: id,
    // The defaults are marked so "default" is meaningful on the toggle screen.
    recommended: chosen.has(id),
  }))
}

/** `watch.enabled` as a two-line menu. */
export function booleanCandidates(current: boolean): Candidate[] {
  return [
    { value: 'true', detail: 'rebuild the page when files change', recommended: current },
    { value: 'false', detail: 'no file watching at all', recommended: !current },
  ]
}

/** The list a field offers, or `undefined` when it takes a plain typed value. */
export type CandidateSource = 'host' | 'plugins' | 'ignore' | 'boolean'

/**
 * Resolve the current selection of a multi-select field, so the menu opens with
 * the checkboxes the file implies rather than an empty list.
 */
export function selectedFrom(file: FileConfig, key: 'plugins' | 'ignore', fallback: readonly string[]): string[] {
  const value = key === 'plugins' ? file.plugins : file.ignore
  return [...(value ?? fallback)]
}
