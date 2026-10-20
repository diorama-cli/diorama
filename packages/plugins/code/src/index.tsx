/**
 * code — syntax-highlighted source files (plan.md M1).
 *
 * Claims textual source/config files by extension and renders them with
 * highlight.js. Languages are registered explicitly: the full highlight.js
 * bundle is ~1 MB, and a viewer needs a handful of common ones.
 *
 * Highlighting is done in the browser from the text the kernel pre-read; the
 * markup comes from highlight.js itself (no repository HTML is interpreted).
 */
import type { Context } from 'cordis'
import { useMemo } from 'react'
import { provideEntry } from 'diorama-ui'
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
import type {} from 'diorama-plugin-slots'
import type { FileRendererProps } from 'diorama-kernel'

export const name = 'code'
export const inject = ['slots']

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
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  // No `svg`: an SVG is a picture. The image piece claims it through the
  // `image/*` mime tier, and an ext entry here would beat that tier (contract
  // §5.1 rule 2). Seeing SVG source needs the source/preview switch (O8, not v1).
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
 * Extensions this renderer claims: every extension that maps to a language.
 * Markdown is deliberately absent — `.md` belongs to the `markdown` renderer,
 * and without it the file falls back to `plaintext`, not to highlighted source.
 */
export const CODE_EXTENSIONS = Object.keys(CODE_LANGUAGES)

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Highlight one file's text; falls back to escaped plain text. */
export function highlight(text: string, path: string): { html: string; language: string } {
  const language = CODE_LANGUAGES[extensionOf(path)]
  if (language === undefined) return { html: escapeHtml(text), language: 'plaintext' }
  try {
    return { html: hljs.highlight(text, { language }).value, language }
  } catch {
    return { html: escapeHtml(text), language: 'plaintext' }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function Code({ file, text }: FileRendererProps) {
  const result = useMemo(() => highlight(text ?? '', file.path), [text, file.path])
  return (
    <div className="diorama-code-wrap" data-testid="code" data-language={result.language}>
      <div className="diorama-code__path">{file.path}</div>
      {text === undefined ? (
        <div className="diorama-renderer__empty" role="status" data-testid="code-binary">
          二进制文件，无法高亮
        </div>
      ) : (
        <pre className="diorama-code">
          {/* highlight.js escapes its input; this markup is generated, not copied. */}
          <code dangerouslySetInnerHTML={{ __html: result.html }} />
        </pre>
      )}
    </div>
  )
}

export function apply(ctx: Context) {
  provideEntry(ctx, {
      id: 'code:renderer',
      name: 'file.renderer',
      key: 'code',
      order: 200,
      matcher: { ext: CODE_EXTENSIONS },
  }, Code)
}
