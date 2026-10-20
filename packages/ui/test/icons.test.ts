import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  baseName,
  FALLBACK_FILE,
  FALLBACK_FOLDER,
  fileGlyph,
  glyphNameForFile,
  glyphNameForFolder,
  iconSvg,
  publishIcons,
  type IconTable,
} from '../src/icons/page.ts'
import { iconTableOnce, installIcons } from '../src/icons/install.ts'
import { iconTable } from '../src/icons/page.ts'

/**
 * The icon layer's rules (docs/m7/spec.md): name tables beat extensions, an
 * unknown name falls to the theme's generic glyph, and a page with no table
 * falls to the neutral fallbacks — never a throw, never a blank column.
 */

const TABLE: IconTable = {
  buttons: { close: { body: '<path d="M1 1"/>' } },
  files: {
    typescript: { viewBox: '0 0 16 16', body: '<path/>' },
    file: { viewBox: '0 0 16 16', body: '<path/>' },
  },
  folders: {
    'folder-src': { viewBox: '0 0 16 16', body: '<path/>' },
    'folder-src-open': { viewBox: '0 0 16 16', body: '<path/>' },
    folder: { viewBox: '0 0 16 16', body: '<path/>' },
    'folder-open': { viewBox: '0 0 16 16', body: '<path/>' },
  },
  extensions: new Map([['ts', 'typescript'], ['d.ts', 'typescript']]),
  fileNames: new Map([['makefile', 'makefile-x']]),
  folderNames: new Map([['src', 'folder-src']]),
}

test('name lookup: a whole file name beats the extension', () => {
  assert.equal(glyphNameForFile(TABLE, 'Makefile'), 'makefile-x')
  assert.equal(glyphNameForFile(TABLE, 'app.ts'), 'typescript')
})

test('extension lookup: compound extensions are tried longest first', () => {
  assert.equal(glyphNameForFile(TABLE, 'a.d.ts'), 'typescript')
  assert.equal(glyphNameForFile(TABLE, 'a.ts'), 'typescript')
})

test('extension lookup: a dotfile has no extension of its own', () => {
  assert.equal(glyphNameForFile(TABLE, '.gitignore'), undefined)
})

test('no table: every question answers undefined, every glyph is a fallback', () => {
  assert.equal(glyphNameForFile(undefined, 'a.ts'), undefined)
  assert.equal(glyphNameForFolder(undefined, 'src'), undefined)
  assert.equal(fileGlyph(undefined, 'a.ts'), FALLBACK_FILE)
  assert.equal(fileGlyph(undefined, 'src', 'dir'), FALLBACK_FOLDER)
})

test('folder glyph: the expanded form is the -open sibling', () => {
  assert.equal(fileGlyph(TABLE, 'src', 'dir', false), TABLE.folders['folder-src'])
  assert.equal(fileGlyph(TABLE, 'src', 'dir', true), TABLE.folders['folder-src-open'])
  // An unnamed directory falls to the generic folder, still state-aware.
  assert.equal(fileGlyph(TABLE, 'unknown', 'dir', false), TABLE.folders['folder'])
  assert.equal(fileGlyph(TABLE, 'unknown', 'dir', true), TABLE.folders['folder-open'])
})

test('unknown file name falls to the generic file glyph', () => {
  assert.equal(fileGlyph(TABLE, 'mystery.bin'), TABLE.files['file'])
})

test('button icons: markup in, fallback out', () => {
  // With the table published, the glyph renders as a 24-grid outline SVG.
  publishIcons(TABLE)
  const svg = iconSvg('close')
  assert.ok(svg.startsWith('<svg width="16"'), svg)
  assert.ok(svg.includes('viewBox="0 0 24 24"'))
  assert.ok(svg.includes('<path d="M1 1"/>'))
  // An unknown semantic name renders nothing (the switcher's first-character
  // fallback), and a page without a table does the same — never a throw.
  assert.equal(iconSvg('no-such-name'), '')
  publishIcons(undefined as unknown as IconTable)
  assert.equal(iconSvg('close'), '')
})

test('baseName: the segment after the last slash', () => {
  assert.equal(baseName('a/b/c.ts'), 'c.ts')
  assert.equal(baseName('c.ts'), 'c.ts')
})

test('install: the built table resolves real files and publishes once', () => {
  const table = installIcons()
  assert.equal(table, iconTableOnce())
  // The generated artwork covers the common cases of a repository like this one.
  // (`.tsx` is `react_ts` — the theme's own choice, kept verbatim.)
  assert.equal(glyphNameForFile(table, 'index.ts'), 'typescript')
  assert.equal(glyphNameForFile(table, 'index.tsx'), 'react_ts')
  assert.equal(glyphNameForFile(table, 'package.json'), 'nodejs')
  assert.equal(glyphNameForFile(table, 'diorama.toml'), 'toml')
  assert.equal(glyphNameForFolder(table, 'src'), 'folder-src')
  // …and the glyphs are well-formed inline SVGs.
  assert.ok(table.files['typescript']!.body.startsWith('<path'))
  assert.ok(table.files['typescript']!.viewBox.length > 0)
  assert.equal(iconTable(), table)
})
