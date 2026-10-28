/**
 * Extension → MIME inference (contract.md §5.1, §4).
 *
 * Two readers, one table:
 *
 * - the `file.renderer` matcher tiers compare against the **bare** type
 *   (`text/plain`, `image/*`), so this table never carries parameters;
 * - the raw-bytes route (`/~raw~/`, §4) hands the same type to the browser —
 *   there, and only there, `rawContentType` appends `charset=utf-8` for the
 *   textual ones, because a `text/*` without a charset is guessed by the
 *   browser and a UTF-8 file comes out as mojibake.
 *
 * It is still not a general-purpose type database: it is the set of extensions
 * a source tree actually holds, grouped so that adding one is obvious. Anything
 * unknown is `application/octet-stream` — a browser saves it, which is the
 * honest answer for a file the viewer cannot claim.
 */
import type { RelPath } from './types.ts'

/** Extensions whose content is text, mapped to the type a browser can show. */
const TEXT_TYPES: Record<string, string> = {
  // Documents and plain text
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  nfo: 'text/plain',
  readme: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  rst: 'text/x-rst',
  adoc: 'text/asciidoc',
  tex: 'text/x-tex',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  diff: 'text/x-diff',
  patch: 'text/x-diff',

  // Markup, style, data
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  css: 'text/css',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  styl: 'text/x-stylus',
  xml: 'text/xml',
  xsl: 'text/xml',
  xslt: 'text/xml',
  dtd: 'text/xml',
  rss: 'text/xml',
  atom: 'text/xml',
  plist: 'text/xml',
  svg: 'image/svg+xml',
  json: 'application/json',
  jsonc: 'application/json',
  json5: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/toml',
  ini: 'text/x-ini',
  cfg: 'text/x-ini',
  conf: 'text/x-ini',
  properties: 'text/x-ini',
  env: 'text/x-ini',
  editorconfig: 'text/x-ini',
  gitignore: 'text/plain',
  gitattributes: 'text/plain',
  npmrc: 'text/plain',
  lock: 'text/plain',

  // Programming languages (source is text: a browser shows it)
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  mts: 'text/typescript',
  cts: 'text/typescript',
  tsx: 'text/typescript',
  vue: 'text/plain',
  svelte: 'text/plain',
  astro: 'text/plain',
  py: 'text/x-python',
  pyi: 'text/x-python',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  scala: 'text/x-scala',
  swift: 'text/x-swift',
  m: 'text/x-objective-c',
  mm: 'text/x-objective-c',
  c: 'text/x-c',
  h: 'text/x-c',
  cc: 'text/x-c',
  cpp: 'text/x-c',
  cxx: 'text/x-c',
  hpp: 'text/x-c',
  hh: 'text/x-c',
  hxx: 'text/x-c',
  cs: 'text/x-csharp',
  fs: 'text/x-fsharp',
  vb: 'text/x-vb',
  lua: 'text/x-lua',
  pl: 'text/x-perl',
  pm: 'text/x-perl',
  r: 'text/x-r',
  dart: 'text/x-dart',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  erl: 'text/x-erlang',
  hs: 'text/x-haskell',
  clj: 'text/x-clojure',
  cljs: 'text/x-clojure',
  jl: 'text/x-julia',
  nim: 'text/x-nim',
  zig: 'text/x-zig',
  groovy: 'text/x-groovy',
  gradle: 'text/x-groovy',
  sql: 'text/x-sql',
  graphql: 'text/x-graphql',
  gql: 'text/x-graphql',
  proto: 'text/x-protobuf',
  sol: 'text/x-solidity',
  tf: 'text/x-hcl',
  hcl: 'text/x-hcl',
  nix: 'text/x-nix',
  cmake: 'text/x-cmake',
  mk: 'text/x-makefile',
  makefile: 'text/x-makefile',
  dockerfile: 'text/x-dockerfile',
  asm: 'text/x-asm',
  s: 'text/x-asm',
  wat: 'text/x-wasm',

  // Shell
  sh: 'text/x-sh',
  bash: 'text/x-sh',
  zsh: 'text/x-sh',
  fish: 'text/x-sh',
  ksh: 'text/x-sh',
  csh: 'text/x-sh',
  ps1: 'text/x-powershell',
  psm1: 'text/x-powershell',
  bat: 'text/x-msdos-batch',
  cmd: 'text/x-msdos-batch',
}

/** Binary types a browser knows how to show or play, rather than save. */
const BINARY_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
}

const TYPES: Record<string, string> = { ...TEXT_TYPES, ...BINARY_TYPES }

/**
 * Files with **no extension** that are known by name: build files, licences,
 * readmes. `extensionOf` answers `''` for every one of them, so without this
 * table a `Makefile` was an opaque download while `makefile.mk` was text.
 */
const NAMED_TYPES: Record<string, string> = {
  makefile: 'text/x-makefile',
  gnumakefile: 'text/x-makefile',
  dockerfile: 'text/x-dockerfile',
  containerfile: 'text/x-dockerfile',
  vagrantfile: 'text/plain',
  gemfile: 'text/x-ruby',
  rakefile: 'text/x-ruby',
  brewfile: 'text/x-ruby',
  podfile: 'text/x-ruby',
  cmakelists: 'text/x-cmake',
  license: 'text/plain',
  licence: 'text/plain',
  copying: 'text/plain',
  notice: 'text/plain',
  readme: 'text/plain',
  changelog: 'text/plain',
  changes: 'text/plain',
  authors: 'text/plain',
  contributors: 'text/plain',
  todo: 'text/plain',
  procfile: 'text/plain',
  codeowners: 'text/plain',
  '.gitignore': 'text/plain',
  '.gitattributes': 'text/plain',
  '.gitmodules': 'text/plain',
  '.dockerignore': 'text/plain',
  '.npmignore': 'text/plain',
  '.editorconfig': 'text/x-ini',
  '.npmrc': 'text/x-ini',
  '.nvmrc': 'text/plain',
  '.babelrc': 'application/json',
  '.eslintrc': 'application/json',
  '.prettierrc': 'application/json',
}

/** Lower-case extension without the dot; `''` when there is none. */
export function extensionOf(path: RelPath): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * Infer a MIME type from a relative path; unknown types are
 * `application/octet-stream` (a browser saves them, which is the honest answer
 * for a file the viewer cannot claim).
 *
 * A **dotfile** (`.gitignore`, `.env`) has no extension by the rule above —
 * `extensionOf` treats the leading dot as the start of the name, not of an
 * extension. Those are configuration files and every one of them is text, so
 * they are answered as text rather than as an opaque download.
 */
export function mimeOf(path: RelPath): string {
  const extension = extensionOf(path)
  const known = TYPES[extension]
  if (known !== undefined) return known
  return mimeOfNamed(path)
}

/**
 * A path with no extension: a dotfile (`.gitignore`, `.env`) or a file known by
 * name (`Makefile`, `LICENSE`). Every one of those is configuration or prose, so
 * the fallback is text rather than an opaque download; a name nobody knows is
 * still `application/octet-stream` (a bare `README` with no extension at all is
 * the one case where guessing would be worse than saying "I don't know").
 */
function mimeOfNamed(path: RelPath): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const lower = name.toLowerCase()
  const known = NAMED_TYPES[lower]
  if (known !== undefined) return known
  // `Dockerfile.dev`, `Makefile.am`, `Gemfile.lock`: the part before the first
  // dot is the name a reader knows, and the suffix is a variant, not a type.
  const dot = lower.indexOf('.')
  const byStem = dot > 0 ? NAMED_TYPES[lower.slice(0, dot)] : undefined
  if (byStem !== undefined) return byStem
  // `.gitignore`, `.env`, `.npmrc`: a leading dot starts the name, not an ext.
  if (name.startsWith('.') && name.length > 1) return 'text/plain'
  return 'application/octet-stream'
}

/** Structured types that are text even though their name does not say so. */
const TEXTUAL_APPLICATIONS = new Set([
  'application/json',
  'application/x-ndjson',
  'application/manifest+json',
  'application/xhtml+xml',
])

/**
 * Whether a type is text, and therefore wants a `charset` on the wire.
 *
 * `text/*` is the easy half; the rest are the JSON and XML families, which are
 * text by definition and were the ones a browser guessed the encoding of.
 */
export function isTextualMime(type: string): boolean {
  return type.startsWith('text/') || TEXTUAL_APPLICATIONS.has(type)
}
