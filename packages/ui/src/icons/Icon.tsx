/**
 * The two components every piece draws icons with.
 *
 * `<Icon name="close"/>` is a **button** glyph: one stroke path set on a 24×24
 * grid, inheriting `currentColor`, so the button's own CSS decides colour, size
 * and hover. `<FileIcon name="a.ts" kind="file"/>` is a **file-type** glyph: the
 * coloured artwork from Material Icon Theme, picked by the theme's own tables.
 *
 * Both are deliberately tiny and table-driven (see `./page.ts`): the artwork is
 * page data, these components only decide which glyph to draw and how big.
 */
import type { CSSProperties, ReactElement } from 'react'
import { fileGlyph, iconSvg, iconTable, type FileGlyph } from './page.ts'

export interface IconProps {
  /** Semantic name (`close`, `reload`, `caret-right`, …). */
  name: string
  /** Pixel size of the square box. Default `16`. */
  size?: number
  /** Extra class, for spacing rules that belong to the caller. */
  className?: string
  /** Test hook; icons are decorative and carry no text of their own. */
  testId?: string
}

/**
 * A button glyph. Rendered as inline SVG markup (the table stores markup, not
 * components) — the same mechanism `sidebar.views` uses for its `icon` field.
 *
 * `aria-hidden` is set: the surrounding control owns the accessible name
 * (`aria-label` / its text), and announcing "close" twice is noise.
 */
export function Icon({ name, size = 16, className, testId }: IconProps): ReactElement | null {
  const svg = iconSvg(name, size)
  if (svg === '') return null
  return (
    <span
      className={className === undefined ? 'diorama-icon' : `diorama-icon ${className}`}
      data-icon={name}
      data-testid={testId}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export interface FileIconProps {
  /** The file or directory name (a base name, not a path). */
  name: string
  /** `dir` picks the folder artwork (and its expanded form). */
  kind?: 'file' | 'dir'
  /** A directory that is open shows the theme's `-open` artwork. */
  expanded?: boolean
  /** Pixel size of the square box. Default `16`. */
  size?: number
  className?: string
}

/**
 * A file-type glyph: the theme's coloured artwork for this name.
 *
 * Unknown names fall back to the theme's generic file / folder glyph, and a
 * page with no icon table (a unit test) gets `FALLBACK_FILE` / `FALLBACK_FOLDER`
 * rather than nothing — a tree row without an icon reads as a missing column.
 */
export function FileIcon({ name, kind = 'file', expanded = false, size = 16, className }: FileIconProps): ReactElement {
  const glyph: FileGlyph = fileGlyph(iconTable(), name, kind, expanded)
  const style: CSSProperties = { width: size, height: size }
  return (
    <span
      className={className === undefined ? 'diorama-file-icon' : `diorama-file-icon ${className}`}
      data-icon={kind === 'dir' ? 'folder' : 'file'}
      aria-hidden="true"
      style={style}
      dangerouslySetInnerHTML={{
        __html: `<svg width="${size}" height="${size}" viewBox="${glyph.viewBox}" fill="none" aria-hidden="true">${glyph.body}</svg>`,
      }}
    />
  )
}
