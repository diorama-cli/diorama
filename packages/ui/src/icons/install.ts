/**
 * Build the page's icon table from the generated artwork.
 *
 * **Only the shell imports this** (`diorama-ui/icons`). It pulls in the
 * generated artwork, which is meant to exist once per page: a client half that
 * imported it would bundle another copy into its own closure — the file table
 * alone is ~170 KB, and the page loads eight halves (see `./page.ts`).
 *
 * The table is built once and published on the page global, where every half
 * reads it. `installIcons()` runs before the first piece renders.
 */
import { BUTTON_GLYPHS } from './button-icons.ts'
import {
  EXTENSION_ROWS,
  FILE_GLYPHS,
  FILE_NAME_ROWS,
  FOLDER_GLYPHS,
  FOLDER_NAME_ROWS,
} from './file-icons.ts'
import { publishIcons, type IconTable } from './page.ts'

/**
 * Expand `"glyph: key key key"` rows into a lookup map. The generated file
 * groups keys by glyph (a quarter of the bytes of one row per key), so the
 * expansion happens once, here, at page boot.
 */
function expand(rows: readonly string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of rows) {
    const colon = row.indexOf(':')
    const glyph = row.slice(0, colon)
    for (const key of row.slice(colon + 1).trim().split(' ')) {
      if (key !== '') map.set(key, glyph)
    }
  }
  return map
}

let installed: IconTable | undefined

/** The page's icon table, built on first use. */
export function iconTableOnce(): IconTable {
  if (installed !== undefined) return installed
  installed = {
    buttons: BUTTON_GLYPHS,
    files: FILE_GLYPHS,
    folders: FOLDER_GLYPHS,
    extensions: expand(EXTENSION_ROWS),
    fileNames: expand(FILE_NAME_ROWS),
    folderNames: expand(FOLDER_NAME_ROWS),
  }
  return installed
}

/**
 * Publish the table for every half of this page. The shell calls this **before**
 * the first piece renders, so the very first tree paint already has glyphs.
 */
export function installIcons(): IconTable {
  const table = iconTableOnce()
  publishIcons(table)
  return table
}

export type { ButtonGlyph, FileGlyph, IconTable } from './page.ts'
