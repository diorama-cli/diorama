/**
 * Choosing the renderer for one file (contract.md §5.1).
 *
 * Pure and React-free: the `renderer-registry` piece calls it with the current
 * entries, the file, and a way to obtain the probe head, and gets back either
 * the entry that should render, or reasons why nothing can.
 *
 * Order of scanning (`ext` → `mime` → `probe`) is what makes `ext` always beat
 * `mime` and `mime` always beat `probe`, without running a probe per file.
 */
import type { FileInfo, FileMatcher, RelPath } from 'diorama-kernel'

/** The slot key renderers register under (`file.renderer`). */
export const RENDERER_SLOT = 'file.renderer'

/** Bytes a probe may inspect (contract.md §5.1). */
export const PROBE_HEAD_BYTES = 4096

/** Lower-case extension without the dot; `''` when there is none. */
function extensionOf(path: RelPath): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** A registered renderer as the chooser sees it. */
export interface RendererCandidate {
  id: string
  order: number
  matcher?: FileMatcher
}

/** What a file looks like to the chooser. */
export interface RendererSubject {
  file: FileInfo
  mime: string
}

/** Why no renderer could be chosen. */
export type RendererFailure =
  | { kind: 'failed'; ids: string[]; errors: string[] }
  | { kind: 'empty' }
  | { kind: 'no-match' }
  | { kind: 'no-fallback' }

/** The chooser's answer: choose, or explain. */
export type RendererChoice =
  | { kind: 'match'; id: string; tier: 'ext' | 'mime' | 'probe' }
  | { kind: 'fallback'; id: string }
  | RendererFailure

export interface ChooseOptions {
  /** Probe head provider; only called when probes are reached. */
  head?(path: RelPath): Promise<Uint8Array>
  /** Cheap vs expensive probes: expensive ones run only after cheap ones missed. */
  isExpensive?(matcher: FileMatcher): boolean
  /** Errors of entries already marked failed (for the failure message). */
  errorOf?(id: string): string | undefined
}

function isExtension(matcher: FileMatcher): matcher is { ext: string[] } {
  return Array.isArray((matcher as { ext?: unknown }).ext)
}

function isMime(matcher: FileMatcher): matcher is { mime: string[] } {
  return Array.isArray((matcher as { mime?: unknown }).mime)
}

type ProbeMatcher = Extract<FileMatcher, { probe: (...args: never[]) => boolean }>

function isProbe(matcher: FileMatcher): matcher is ProbeMatcher {
  return typeof (matcher as { probe?: unknown }).probe === 'function'
}

/** Entries with a matcher, in tier order within each tier (order, then id). */
function ordered(candidates: readonly RendererCandidate[]): RendererCandidate[] {
  return [...candidates].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/**
 * Pick the renderer for `subject` among `candidates` (already filtered to the
 * ones that are not marked failed). Returns the chosen entry, the fallback, or
 * a failure that the caller renders instead of nothing.
 */
export async function chooseRenderer(
  candidates: readonly RendererCandidate[],
  subject: RendererSubject,
  options: ChooseOptions = {},
): Promise<RendererChoice> {
  const sorted = ordered(candidates)
  if (sorted.length === 0) return { kind: 'empty' }

  const extension = extensionOf(subject.file.path).toLowerCase()
  const mime = subject.mime.toLowerCase()
  const matched = sorted.filter(candidate => candidate.matcher !== undefined)
  const fallbacks = sorted.filter(candidate => candidate.matcher === undefined)

  if (matched.length === 0) {
    const fallback = fallbacks[0]
    return fallback === undefined ? { kind: 'no-fallback' } : { kind: 'fallback', id: fallback.id }
  }

  // 1. ext
  for (const candidate of matched) {
    const matcher = candidate.matcher as FileMatcher
    if (isExtension(matcher) && matcher.ext.some(item => item.toLowerCase().replace(/^\./, '') === extension)) {
      return { kind: 'match', id: candidate.id, tier: 'ext' }
    }
  }
  // 2. mime
  for (const candidate of matched) {
    const matcher = candidate.matcher as FileMatcher
    if (isMime(matcher) && matcher.mime.some(item => item.toLowerCase() === mime)) {
      return { kind: 'match', id: candidate.id, tier: 'mime' }
    }
  }
  // 3. probe — cheap first, then expensive (contract §5.1 rule 4).
  const probes = matched.filter(candidate => isProbe(candidate.matcher as FileMatcher))
  if (probes.length > 0) {
    let head: Uint8Array | undefined
    for (const expensive of [false, true]) {
      for (const candidate of probes) {
        const matcher = candidate.matcher as ProbeMatcher
        if ((options.isExpensive?.(matcher) ?? matcher.cost === 'expensive') !== expensive) continue
        head ??= (await options.head?.(subject.file.path)) ?? new Uint8Array()
        let hit = false
        try {
          hit = matcher.probe(head, subject.file, subject.mime)
        } catch {
          continue // a broken probe is a miss; the entry itself may still work
        }
        if (hit) return { kind: 'match', id: candidate.id, tier: 'probe' }
      }
    }
  }

  const fallback = fallbacks[0]
  return fallback === undefined ? { kind: 'no-match' } : { kind: 'fallback', id: fallback.id }
}

/** The first `size` bytes of `bytes` (probe head). */
export function probeHead(bytes: Uint8Array, size = PROBE_HEAD_BYTES): Uint8Array {
  return bytes.length <= size ? bytes : bytes.subarray(0, size)
}
