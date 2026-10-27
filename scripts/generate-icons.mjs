#!/usr/bin/env node
/**
 * Generate the two icon tables `diorama-ui` ships (docs/m7/spec.md §2).
 *
 * Why a generator instead of a runtime dependency:
 *
 * - **A client half is a self-contained closure** (m0/spec §10.3): whatever a
 *   half imports is bundled into it, once per half. A React icon library would
 *   be a second copy of the same components in every half *and* in the shell.
 * - **The page's module table is React only** (contract §8): a half cannot
 *   `require` anything else, so a library would have to be bundled anyway.
 * - **A file-type icon table is data, not code**: ~200 glyphs plus a name map.
 *   Data belongs in one place, generated once, readable by every half and by
 *   the shell.
 *
 * Two sources, picked in docs/m7/spec.md §1:
 *
 * - **buttons** — [Tabler Icons](https://tabler.io/icons) (MIT): 24×24 outline
 *   glyphs on a 2px grid, drawn with `currentColor`, so they inherit the text
 *   colour and the size of the control they sit in.
 * - **files** — [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
 *   (MIT): the coloured file / folder glyphs VS Code users know, with a curated
 *   name → glyph table. The table is curated, not copied wholesale: the full
 *   theme is 1.2k glyphs and 87 KB of mappings, most of which no reader here
 *   will ever meet.
 *
 * Both packages are **devDependencies of the repo root**: the output is
 * committed, so building, testing and running need neither. Re-run this script
 * only to add an icon (`pnpm icons`).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'packages/ui/src/icons')

/* ------------------------------------------------------------------ *
 * 1. The button icons: a fixed, named list.
 * ------------------------------------------------------------------ */

/**
 * Icon name (as used in `Icon({ name })`) → Tabler icon id. Only these are
 * emitted; adding a button icon means adding a line here.
 *
 * The names are **semantic**, not pictorial (`close`, not `x`): a piece asks
 * for "the close button's glyph", and swapping the artwork later is one edit.
 */
const BUTTON_ICONS = {
  'caret-down': 'chevron-down',
  'caret-right': 'chevron-right',
  'caret-up': 'chevron-up',
  'columns': 'columns-2',
  'diff': 'arrows-diff',
  'check': 'check',
  'close': 'x',
  'code': 'code',
  'command': 'command',
  'error': 'alert-circle',
  'external-link': 'external-link',
  'eye': 'eye',
  'file-search': 'file-search',
  'file-text': 'file-text',
  'files': 'files',
  'folder': 'folder',
  'folder-open': 'folder-open',
  'git-changes': 'git-compare',
  'git-history': 'history',
  'unfold': 'arrows-vertical',
  'info': 'info-circle',
  'keyboard': 'keyboard',
  'loader': 'loader-2',
  'play': 'player-play',
  'regex': 'regex',
  'reload': 'reload',
  'reveal-file': 'current-location',
  'search': 'search',
  'sidebar-fold': 'layout-sidebar-left-collapse',
  'sidebar-unfold': 'layout-sidebar-left-expand',
  'stop': 'player-stop',
  'text-case': 'letter-case',
  'warning': 'alert-triangle',
  'whole-word': 'abc',
}

/* ------------------------------------------------------------------ *
 * 2. The file icons: a curated set of Material Icon Theme glyphs.
 * ------------------------------------------------------------------ */

/**
 * Glyph names kept from the theme. Everything else the theme defines is
 * dropped, which is what keeps the table small: 200 glyphs, not 1,250.
 *
 * The list is by *glyph*, not by extension: keeping `typescript` also brings
 * every extension the theme points at it (`ts`, `mts`, `cts`, …).
 */
const FILE_GLYPHS = [
  // Languages
  'typescript', 'react_ts', 'javascript', 'react', 'json', 'markdown', 'mdx', 'css', 'sass', 'less',
  'stylus', 'html', 'vue', 'svelte', 'astro', 'python', 'rust', 'go', 'java', 'kotlin', 'swift', 'c',
  'cpp', 'csharp', 'ruby', 'php', 'lua', 'r', 'dart', 'elixir', 'erlang', 'haskell', 'scala', 'clojure',
  'fortran', 'assembly', 'julia', 'matlab', 'nim', 'crystal', 'zig', 'fsharp', 'coffee', 'handlebars',
  'jinja', 'liquid', 'nunjucks', 'postcss', 'prisma', 'graphql', 'proto', 'tex', 'solidity', 'shader',
  'webassembly',
  // Scripts and shells
  'console', 'powershell',
  // Data and documents
  'yaml', 'toml', 'xml', 'table', 'database', 'jupyter', 'diff', 'log', 'lock', 'tune',
  'document', 'word', 'powerpoint', 'pdf', 'todo', 'template',
  // Media and archives
  'image', 'svg', 'zip', 'audio', 'video', 'font', '3d', 'adobe-photoshop', 'sketch', 'figma',
  // Tools and configs
  'nodejs', 'pnpm', 'yarn', 'npm', 'tsconfig', 'jsconfig', 'settings', 'docker', 'makefile', 'cmake',
  'meson', 'bazel', 'maven', 'gradle', 'terraform', 'nginx', 'git', 'gitlab', 'github-actions-workflow',
  'dependabot', 'vscode', 'vim', 'jest', 'cypress', 'playwright', 'storybook', 'eslint', 'prettier',
  'babel', 'webpack', 'rollup', 'vite',
  // Repo furniture
  'readme', 'license', 'changelog',
  // The fallback
  'file',
]

/**
 * Folder glyph names. Each entry stands for a closed/expanded pair: the theme
 * defines `<name>-open` for every folder glyph, and the tree draws the one that
 * matches the expansion state.
 */
const FOLDER_GLYPHS = [
  'folder', 'folder-src', 'folder-lib', 'folder-node', 'folder-git', 'folder-github', 'folder-test',
  'folder-docs', 'folder-dist', 'folder-config', 'folder-public', 'folder-images', 'folder-components',
  'folder-hook', 'folder-utils', 'folder-api', 'folder-views', 'folder-server', 'folder-client',
  'folder-typescript', 'folder-css', 'folder-sass', 'folder-json', 'folder-font', 'folder-i18n',
  'folder-migrations', 'folder-plugin', 'folder-scripts', 'folder-packages', 'folder-app', 'folder-examples',
  'folder-resource', 'folder-database', 'folder-docker', 'folder-vscode', 'folder-temp',
  'folder-log', 'folder-coverage',
]

/* ------------------------------------------------------------------ *
 * 3. Reading the two packages.
 * ------------------------------------------------------------------ */

function readJson(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'))
}

/** Tabler publishes its nodes as JSON (no React, no build step). */
const tablerNodes = readJson('node_modules/@tabler/icons/tabler-nodes-outline.json')

/** Material Icon Theme publishes its manifest plus one SVG file per glyph. */
const material = readJson('node_modules/material-icon-theme/dist/material-icons.json')

function materialSvg(name) {
  const definition = material.iconDefinitions[name]
  if (definition === undefined) throw new Error(`material-icon-theme: no icon "${name}"`)
  const file = join(root, 'node_modules/material-icon-theme/icons', definition.iconPath.split('/').pop())
  return readFileSync(file, 'utf8')
}

/* ------------------------------------------------------------------ *
 * 4. Normalising the artwork into one shape.
 * ------------------------------------------------------------------ */

/** The path/rect/… elements of a Tabler node list, as attribute strings. */
const TABLER_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'])

/**
 * Tabler node → the inner markup of a 24×24 outline icon.
 *
 * Tabler's JSON uses `path` almost everywhere, but `filled`-style nodes and a
 * few others use other primitives; unknown tags are an error rather than
 * silently dropped, so a re-generated table never loses a stroke.
 */
function tablerBody(name) {
  const nodes = tablerNodes[name]
  if (nodes === undefined) throw new Error(`tabler: no icon "${name}"`)
  return nodes
    .map(([tag, attributes]) => {
      if (!TABLER_TAGS.has(tag)) throw new Error(`tabler: "${name}" uses unsupported <${tag}>`)
      const attrs = Object.entries(attributes)
        // `key` is a React bookkeeping field, not an SVG attribute.
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => `${key}="${String(value).replace(/"/g, '&quot;')}"`)
        .join(' ')
      return `<${tag} ${attrs}/>`
    })
    .join('')
}

/**
 * Material SVG → `{ viewBox, body }`, with the wrapper attributes the tree's
 * CSS overrides (size) removed and everything the artwork needs kept.
 *
 * The theme's files are already minimal: one `<svg>`, `path`/`g`/`circle`/`use`
 * children, occasionally a `<defs>` with a gradient whose `id` is `a`. Ids are
 * **scoped per icon** below: two inlined icons that both define `id="a"` would
 * otherwise fight (the second one's gradient would repaint the first).
 */
function materialBody(name) {
  const svg = materialSvg(name)
  const open = svg.match(/<svg[^>]*>/)
  if (open === null) throw new Error(`material-icon-theme: "${name}" has no <svg>`)
  const viewBox = open[0].match(/viewBox="([^"]+)"/)
  if (viewBox === null) throw new Error(`material-icon-theme: "${name}" has no viewBox`)
  // The root's own attributes matter: some glyphs set `fill` or `clip-rule` on
  // the wrapper and rely on inheritance. Keep them, minus the ones the inline
  // <svg> supplies itself (namespace, coordinate system, size).
  const attrs = [...open[0].matchAll(/ ([a-zA-Z:-]+)="([^"]*)"/g)]
    .filter(([, key]) => !['xmlns', 'xmlns:xlink', 'viewBox', 'width', 'height'].includes(key))
    .map(([, key, value]) => `${key}="${value}"`)
    .join(' ')
  let body = svg.slice(open[0].length, svg.lastIndexOf('</svg>')).trim()
  // Every id in this file is local to it; prefix them so inlining is safe.
  const id = `m-${name}`
  body = body
    .replace(/\sid="([^"]+)"/g, (_match, local) => ` id="${id}-${local}"`)
    .replace(/url\(#([^)]+)\)/g, (_match, local) => `url(#${id}-${local})`)
    .replace(/href="#([^"]+)"/g, (_match, local) => `href="#${id}-${local}"`)
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
  return { viewBox: viewBox[1], attrs, body }
}

/* ------------------------------------------------------------------ *
 * 5. Emitting.
 * ------------------------------------------------------------------ */

const buttonEntries = Object.entries(BUTTON_ICONS).map(([name, tablerName]) => ({
  name,
  body: tablerBody(tablerName),
}))

const fileGlyphs = {}
for (const name of FILE_GLYPHS) fileGlyphs[name] = materialBody(name)
const folderGlyphs = {}
for (const name of FOLDER_GLYPHS) {
  for (const variant of [name, `${name}-open`]) folderGlyphs[variant] = materialBody(variant)
}

/**
 * The name tables, taken from the theme's own maps but **filtered to the
 * glyphs kept above**. Grouped by glyph (one row per glyph, extensions after a
 * colon) because the raw JSON is four times the size and this file is source.
 */
function group(map, keep) {
  const rows = new Map()
  for (const [key, glyph] of Object.entries(map)) {
    if (!keep.has(glyph)) continue
    const list = rows.get(glyph)
    if (list === undefined) rows.set(glyph, [key])
    else list.push(key)
  }
  return [...rows].map(([glyph, keys]) => `${glyph}: ${keys.sort().join(' ')}`)
}

const fileGlyphNames = new Set(Object.keys(fileGlyphs))
const folderGlyphNames = new Set(Object.keys(folderGlyphs))

const extensionRows = group(material.fileExtensions, fileGlyphNames)
const fileNameRows = group(material.fileNames, fileGlyphNames)
const folderNameRows = group(material.folderNames, folderGlyphNames)

const header = `/**
 * GENERATED by scripts/generate-icons.mjs — do not edit by hand.
 *
 * Sources (both MIT, both devDependencies of the repo root):
 * - button glyphs: Tabler Icons (https://tabler.io/icons)
 * - file glyphs:   Material Icon Theme (https://github.com/material-extensions/vscode-material-icon-theme)
 *
 * Re-generate with \`pnpm icons\` after editing the curated lists in the script.
 */
`

writeFileSync(
  join(out, 'button-icons.ts'),
  `${header}
/** One button glyph: the inner markup of a 24×24, 2px-stroke outline icon. */
export interface ButtonGlyph {
  readonly body: string
}

/** Semantic name → glyph. Drawn with \`currentColor\`, so colour and size come from CSS. */
export const BUTTON_GLYPHS: Readonly<Record<string, ButtonGlyph>> = {
${buttonEntries.map(({ name, body }) => `  ${JSON.stringify(name)}: { body: ${JSON.stringify(body)} },`).join('\n')}
}
`,
)

writeFileSync(
  join(out, 'file-icons.ts'),
  `${header}
/** One file / folder glyph: the theme's own artwork, inlined. */
export interface FileGlyph {
  /** The artwork's coordinate system (the theme does not use one size). */
  readonly viewBox: string
  /** Root attributes the artwork inherits from (\`fill\`, \`clip-rule\`, …); may be empty. */
  readonly attrs?: string
  readonly body: string
}

/** Glyphs by theme name (\\\`typescript\\\`, \\\`folder-src-open\\\`, …). */
export const FILE_GLYPHS: Readonly<Record<string, FileGlyph>> = {
${Object.entries(fileGlyphs)
  .map(([name, glyph]) => `  ${JSON.stringify(name)}: ${JSON.stringify(glyph)},`)
  .join('\n')}
}

/** Folder glyphs, both states: \\\`folder-src\\\` and \\\`folder-src-open\\\`. */
export const FOLDER_GLYPHS: Readonly<Record<string, FileGlyph>> = {
${Object.entries(folderGlyphs)
  .map(([name, glyph]) => `  ${JSON.stringify(name)}: ${JSON.stringify(glyph)},`)
  .join('\n')}
}

/** \`<glyph name>: <ext> <ext> …\`, grouped by glyph to keep this file readable. */
export const EXTENSION_ROWS = ${JSON.stringify(extensionRows, null, 0)}

/** \`<glyph name>: <file name> …\` — whole-name matches beat the extension. */
export const FILE_NAME_ROWS = ${JSON.stringify(fileNameRows, null, 0)}

/** \`<glyph name>: <folder name> …\` — a directory's name picks its glyph. */
export const FOLDER_NAME_ROWS = ${JSON.stringify(folderNameRows, null, 0)}
`,
)

const total = buttonEntries.length + Object.keys(fileGlyphs).length + Object.keys(folderGlyphs).length
console.log(`icons: ${buttonEntries.length} button, ${Object.keys(fileGlyphs).length} file, ${Object.keys(folderGlyphs).length} folder (${total} glyphs)`)
console.log(`tables: ${extensionRows.length} extension rows, ${fileNameRows.length} name rows, ${folderNameRows.length} folder rows`)
