/**
 * The page's icon table: one copy of the artwork per page, read by every piece.
 *
 * ## Why the table is not a module import
 *
 * A client half is a **self-contained closure** (docs/m0/spec.md §10.3): every
 * module it imports is bundled into that half. `diorama-ui` is imported by most
 * halves, so a table that lives in this module's import graph would be copied
 * into each of them — the file glyphs alone are ~170 KB, and the page loads
 * eight halves.
 *
 * So the artwork is **data the shell installs once** (`diorama-ui/icons`), and
 * this module is the small reader every half bundles: the same shape as the
 * page bridge (`__diorama_page__`), the reveal store (`__diorama_reveal__`) and
 * the overlay store. The page global is the only thing two separately built
 * halves share (docs/m4/spec.md §6.2 trap 13).
 *
 * ## The tables
 *
 * - **buttons** — semantic names (`close`, `reload`, `caret-right`) → 24×24
 *   outline markup, drawn with `currentColor` so a button's CSS decides colour.
 * - **files / folders** — Material Icon Theme glyphs by their own names, plus
 *   the theme's three lookup tables (whole name → glyph, extension → glyph,
 *   folder name → glyph).
 *
 * `scripts/generate-icons.mjs` writes them; nothing here parses SVG at runtime.
 */

/** One button glyph: the inner markup of a 24×24, 2px-stroke outline icon. */
export interface ButtonGlyph {
  readonly body: string
}

/** One file / folder glyph: the source theme's artwork, inlined verbatim. */
export interface FileGlyph {
  /** The artwork's own coordinate system (the theme is not one size). */
  readonly viewBox: string
  readonly body: string
}

/** What a page installs before it boots pieces (see `installIcons`). */
export interface IconTable {
  readonly buttons: Readonly<Record<string, ButtonGlyph>>
  readonly files: Readonly<Record<string, FileGlyph>>
  readonly folders: Readonly<Record<string, FileGlyph>>
  /** Extension (lowercase, no dot; may be compound: `d.ts`) → glyph name. */
  readonly extensions: ReadonlyMap<string, string>
  /** Whole file name (lowercase) → glyph name. Beats the extension. */
  readonly fileNames: ReadonlyMap<string, string>
  /** Folder name (lowercase) → glyph name. */
  readonly folderNames: ReadonlyMap<string, string>
}

/**
 * The table the page installed, or `undefined` in a page that never installed
 * one (a unit test, or a half rendered outside the shell). Callers fall back to
 * the neutral glyphs below rather than throwing: an icon is decoration, and a
 * missing table must not blank a file list.
 */
export function iconTable(): IconTable | undefined {
  return (globalThis as unknown as { __diorama_icons__?: IconTable }).__diorama_icons__
}

/** Publish a table for the pieces of this page. Called by the shell, once. */
export function publishIcons(table: IconTable): void {
  ;(globalThis as unknown as { __diorama_icons__?: IconTable }).__diorama_icons__ = table
}

/**
 * The glyph drawn when the table is missing: a plain file and a plain folder,
 * in the same 16×16 box as the theme's own, so a page without the table still
 * shows a recognisable (if uncoloured) tree.
 */
export const FALLBACK_FILE: FileGlyph = {
  viewBox: '0 0 16 16',
  body: '<path fill="#90a4ae" d="M3 1h6l4 4v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1m6 1.5V5h2.5z"/>',
}

export const FALLBACK_FOLDER: FileGlyph = {
  viewBox: '0 0 16 16',
  body: '<path fill="#90a4ae" d="m6.922 3.768-.644-.536A1 1 0 0 0 5.638 3H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.562a1 1 0 0 1-.64-.232"/>',
}

/**
 * The button glyph for a semantic name, as **inline SVG markup** — the shape
 * `sidebar.views` entries take (contract.md §5.2: `icon?: string`).
 *
 * Returns `''` when the page has no table (the server half runs `apply` too,
 * and its registration is never drawn) — the switcher then falls back to the
 * view's first character, which is the contract's own default.
 */
export function iconSvg(name: string, size = 16): string {
  const body = iconTable()?.buttons[name]?.body
  if (body === undefined) return ''
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

/** A file's extension chain, longest first: `a.d.ts` → `d.ts`, `ts`. */
function suffixes(name: string): string[] {
  const parts = name.split('.')
  // A dotfile (`.gitignore`) has no extension of its own; its whole name is the
  // thing the theme's name table knows.
  if (parts.length < 2 || parts[0] === '') return []
  const out: string[] = []
  for (let index = 1; index < parts.length; index++) out.push(parts.slice(index).join('.').toLowerCase())
  return out
}

/** The glyph name a file name resolves to, or `undefined` (the caller's default). */
export function glyphNameForFile(table: IconTable | undefined, name: string): string | undefined {
  if (table === undefined) return undefined
  const lower = name.toLowerCase()
  const byName = table.fileNames.get(lower)
  if (byName !== undefined) return byName
  for (const suffix of suffixes(lower)) {
    const byExtension = table.extensions.get(suffix)
    if (byExtension !== undefined) return byExtension
  }
  return undefined
}

/** The glyph name a directory name resolves to, or `undefined`. */
export function glyphNameForFolder(table: IconTable | undefined, name: string): string | undefined {
  if (table === undefined) return undefined
  return table.folderNames.get(name.toLowerCase())
}

/** The glyph a tree row draws: a directory's name, or a file's name + extension. */
export function fileGlyph(
  table: IconTable | undefined,
  name: string,
  kind: 'file' | 'dir' = 'file',
  expanded = false,
): FileGlyph {
  if (table === undefined) return kind === 'dir' ? FALLBACK_FOLDER : FALLBACK_FILE
  if (kind === 'dir') {
    // A directory's glyph follows its name (`src` has its own folder artwork)
    // and its state (the theme draws every folder twice, closed and open). The
    // generator keeps both halves of each pair, so `-open` exists whenever the
    // closed one does.
    const named = glyphNameForFolder(table, name) ?? 'folder'
    const wanted = expanded ? `${named}-open` : named
    return table.folders[wanted] ?? table.folders[named] ?? table.folders['folder'] ?? FALLBACK_FOLDER
  }
  const named = glyphNameForFile(table, name)
  return (named === undefined ? undefined : table.files[named]) ?? table.files['file'] ?? FALLBACK_FILE
}

/** The last path segment (the tree and the tab strip label rows by it). */
export function baseName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}
