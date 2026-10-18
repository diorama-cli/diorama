/**
 * Extension → MIME inference for the `file.renderer` matcher (contract.md §5.1).
 *
 * Deliberately a small table: it only has to be good enough for the `ext` and
 * `mime` matcher tiers, never a general-purpose type database.
 */
import type { RelPath } from './types.ts'

const TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  ts: 'text/typescript',
  mts: 'text/typescript',
  cts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  json: 'application/json',
  jsonc: 'application/json',
  map: 'application/json',
  toml: 'text/toml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  xml: 'text/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
}

/** Extensions whose content is textual (a plaintext `code` renderer may show them). */
const TEXTUAL = new Set(Object.keys(TYPES).filter(ext => {
  const type = TYPES[ext] as string
  return type.startsWith('text/') || type === 'application/json'
}))

/** Lower-case extension without the dot; `''` when there is none. */
export function extensionOf(path: RelPath): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** Infer a MIME type from a relative path; unknown types are `application/octet-stream`. */
export function mimeOf(path: RelPath): string {
  const extension = extensionOf(path)
  const known = TYPES[extension]
  if (known !== undefined) return known
  if (extension === '') return 'application/octet-stream'
  // Common source/config files with no table entry are still text.
  return TEXTUAL.has(extension) ? 'text/plain' : 'application/octet-stream'
}
