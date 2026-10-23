/**
 * Math and diagrams in a Markdown document.
 *
 * Two things a document may carry that are *not* HTML and must not be rendered
 * at parse time:
 *
 * - **math** — `$x^2$` (inline) and `$$…$$` (a block). KaTeX is ~280 KB of
 *   JavaScript plus 20 font files, and most documents have no math at all, so
 *   the parser only marks the spot: it emits a placeholder whose **text** is
 *   the TeX, and `enhance.ts` renders it **after mount**, loading KaTeX the
 *   first time a document actually needs it.
 * - **diagrams** — a ```mermaid fence. Mermaid is ~3.5 MB; same rule. The
 *   fence's source is the `<pre><code>` inside the placeholder, which is also
 *   the readable fallback when Mermaid is not loaded (or fails on the source).
 *
 * The source is **text content, never an attribute**. A diagram is full of
 * `-->`, and DOMPurify drops any attribute whose value contains a comment
 * closer (`-->`, `]>`) — it is an XML re-parse hazard. Text is escaped by the
 * sanitiser and read back with `textContent`, which is the same rule that keeps
 * every other piece of document content safe.
 *
 * The placeholder is plain HTML, so a document with neither costs nothing.
 * Both libraries are served from the piece's own package
 * (`/plugins/markdown/vendor/`, contract.md §5.1) rather than bundled into the
 * client half: a half is a self-contained closure, and every page would pay.
 *
 * Pure: this module builds strings only. `node --test` can load it.
 */
import type { MarkedExtension, Tokens } from 'marked'

/** A math token the extension produced (marked's own tokens are open-ended). */
export interface MathToken extends Tokens.Generic {
  type: 'mathInline' | 'mathBlock'
  /** The TeX source, trimmed. */
  text: string
  /** `$$` (block) rather than `$` (inline). */
  displayMode: boolean
}

/**
 * Inline math, GitHub's rule: `$` with no space inside, one line, closed by
 * another `$` that is **not followed by a digit**.
 *
 * The last condition is what keeps prose readable: `$5 and $6` is money, and a
 * naive rule reads `5 and ` as a formula (the closing `$` sits right before the
 * `6`). Requiring no space just inside the delimiters is the other half of the
 * same rule — `$ x $` is a sentence about a dollar, not math.
 */
const INLINE_RULE = /^\$(?!\s)((?:\\.|[^\\\n$])+?)(?<!\s)\$(?!\d)/

/**
 * Block math: `$$` on lines of its own (the fence-like form), or `$$…$$` on
 * one line. A block is display math either way.
 */
const BLOCK_FENCE_RULE = /^\$\$[ \t]*\n((?:\\[^]|[^\\])+?)\n\$\$[ \t]*(?:\n|$)/
const BLOCK_LINE_RULE = /^\$\$((?:\\.|[^\\\n$])+?)\$\$[ \t]*(?:\n|$)/

/** `& < > " '` — the five characters that change meaning inside markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The placeholder for one formula. Its text is the escaped TeX, so a page that
 * never loads KaTeX still shows something honest (`x^2`, not blank) — and
 * `enhance.ts` reads the same text back out.
 */
export function mathPlaceholder(tex: string, display: boolean): string {
  const escaped = escapeHtml(tex)
  const kind = display ? 'block' : 'inline'
  const tag = display ? 'div' : 'span'
  const newline = display ? '\n' : ''
  return `<${tag} class="diorama-math diorama-math--${kind}" data-math="${kind}">${escaped}</${tag}>${newline}`
}

/** The language tag that makes a fence a diagram. */
export const MERMAID_LANG = 'mermaid'

/** Whether a fence's info string names Mermaid (`mermaid`, `mermaid title=…`). */
export function isMermaidFence(lang: string | undefined): boolean {
  return lang !== undefined && lang.trim().split(/\s+/)[0]?.toLowerCase() === MERMAID_LANG
}

/**
 * The placeholder for one diagram: the source as `<pre><code>` text. A reader
 * sees the diagram's own source before Mermaid arrives, and keeps seeing it if
 * Mermaid refuses the source (an error is not worth a dialog — the text is what
 * they need to fix).
 */
export function mermaidPlaceholder(source: string): string {
  const escaped = escapeHtml(source)
  return (
    `<div class="diorama-mermaid" data-mermaid="">` +
    `<pre class="diorama-mermaid__source"><code>${escaped}</code></pre></div>\n`
  )
}

/**
 * Where the next `$` that could open inline math sits, or `undefined`.
 *
 * `start` is what lets marked jump to a `$` instead of trying the tokenizer at
 * every character; the index is **relative to `src`**, so the scan accumulates
 * its offset as it walks (returning an index from a shortened tail would cut
 * the paragraph in the wrong place).
 */
function startOfInlineMath(src: string): number | undefined {
  let offset = 0
  while (offset < src.length) {
    const at = src.indexOf('$', offset)
    if (at === -1) return undefined
    if (INLINE_RULE.test(src.slice(at))) return at
    offset = at + 1
  }
  return undefined
}

/**
 * The marked extension: an inline rule and a block rule, both rendering
 * {@link mathPlaceholder}.
 */
export function mathExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'mathInline',
        level: 'inline',
        start: startOfInlineMath,
        tokenizer(src: string): MathToken | undefined {
          const match = INLINE_RULE.exec(src)
          if (match === null) return undefined
          return { type: 'mathInline', raw: match[0], text: (match[1] ?? '').trim(), displayMode: false }
        },
        renderer(token: Tokens.Generic): string {
          const math = token as MathToken
          return mathPlaceholder(math.text, math.displayMode)
        },
      },
      {
        name: 'mathBlock',
        level: 'block',
        tokenizer(src: string): MathToken | undefined {
          const match = BLOCK_FENCE_RULE.exec(src) ?? BLOCK_LINE_RULE.exec(src)
          if (match === null) return undefined
          return { type: 'mathBlock', raw: match[0], text: (match[1] ?? '').trim(), displayMode: true }
        },
        renderer(token: Tokens.Generic): string {
          const math = token as MathToken
          return mathPlaceholder(math.text, math.displayMode)
        },
      },
    ],
  }
}
