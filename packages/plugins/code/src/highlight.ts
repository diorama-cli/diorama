/**
 * The highlight engine: one text → HTML, and one text → **HTML per line**.
 *
 * The whole-document form is what the `code` renderer draws. The per-line form
 * is what every **diff reader** needs (contract.md §5.2): a diff is drawn one
 * row at a time — folded runs, a gutter, a blank cell on one side of the
 * two-column reader — so a row cannot rely on a span that opened on a line the
 * reader did not draw. Each line therefore comes back **self-contained**:
 * spans still open at a line break are closed there and reopened on the next
 * line, so the colouring survives the cut.
 *
 * Pure on purpose (no React, no DOM, no IO): `node --test` can pin the rules
 * (docs/m4/spec.md §6.2: a `.tsx` cannot be imported by `node --test`).
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/** Extension → highlight.js language id. */
export const CODE_LANGUAGES: Readonly<Record<string, string>> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  map: 'json',
  css: 'css',
  xml: 'xml',
  // No `svg`: an SVG is a picture. The image piece claims it through the
  // `image/*` mime tier, and an ext entry here would beat that tier (contract
  // §5.1 rule 2). Seeing SVG source needs the source/preview switch (O8, not v1).
  // No `html` / `htm` either: the html piece owns them (contract §5.1 rule 2)
  // and shows the source itself when the preview is switched off.
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
}

const REGISTERED: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}

for (const [language, definition] of Object.entries(REGISTERED)) {
  hljs.registerLanguage(language, definition)
}

/**
 * Extensions this engine knows: every extension that maps to a language.
 * Markdown is deliberately absent — `.md` belongs to the `markdown` renderer,
 * and without it the file falls back to `plaintext`, not to highlighted source.
 */
export const CODE_EXTENSIONS = Object.keys(CODE_LANGUAGES)

/** The extension of a path (`''` when it has none: `.gitignore` is a name). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The language a path is highlighted as; `plaintext` means "not one". */
export function languageOf(path: string): string {
  return CODE_LANGUAGES[extensionOf(path)] ?? 'plaintext'
}

/** Escape text for HTML (highlight.js escapes its own input; plain text does not). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Highlight one file's text; falls back to escaped plain text. */
export function highlight(text: string, path: string): { html: string; language: string } {
  const language = languageOf(path)
  if (language === 'plaintext') return { html: escapeHtml(text), language }
  try {
    return { html: hljs.highlight(text, { language }).value, language }
  } catch {
    return { html: escapeHtml(text), language: 'plaintext' }
  }
}

/** Split a text into lines the way every reader counts them (no trailing tail). */
export function splitTextLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Cut highlighted HTML at its line breaks, closing and reopening the spans
 * that straddle a break, so every returned line stands on its own.
 *
 * highlight.js emits spans that may cover a line break (a block comment, a
 * multi-line string). A diff reader draws rows one at a time, so a span left
 * open at the end of a row would either colour the next row by accident or
 * (with `dangerouslySetInnerHTML` per row) not be closed at all.
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = []
  /** Opening tags currently in force, outermost first. */
  const open: string[] = []
  let current = ''
  let index = 0
  while (index < html.length) {
    const char = html[index] as string
    if (char === '<') {
      const end = html.indexOf('>', index)
      // A malformed fragment: keep the rest verbatim rather than dropping it.
      if (end === -1) {
        current += html.slice(index)
        break
      }
      const tag = html.slice(index, end + 1)
      if (tag.startsWith('</')) open.pop()
      else if (!tag.endsWith('/>')) open.push(tag)
      current += tag
      index = end + 1
      continue
    }
    if (char === '\n') {
      // Close what this line opened, then reopen it on the next one.
      current += closeAll(open)
      lines.push(current)
      current = open.join('')
      index += 1
      continue
    }
    current += char
    index += 1
  }
  current += closeAll(open)
  lines.push(current)
  // A text that ends with a newline has no extra (empty) line: the readers
  // count lines the same way `splitTextLines` does.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Closing tags for an open-tag stack, innermost first. */
function closeAll(open: readonly string[]): string {
  let out = ''
  for (let index = open.length - 1; index >= 0; index--) {
    const name = /^<([a-zA-Z][\w-]*)/.exec(open[index] as string)?.[1]
    if (name !== undefined) out += `</${name}>`
  }
  return out
}

/**
 * One text as HTML per line — the shape a diff reader draws (contract.md
 * §5.2). `lines[i]` is line `i + 1`; each entry is complete on its own, so a
 * reader may draw any subset of them (folded runs, one column of a pair).
 */
export function highlightLines(text: string, path: string): string[] {
  const { html } = highlight(text, path)
  return splitHighlightedHtml(html)
}
