/**
 * What a hover card **is** (contract.md §3.12).
 *
 * A language server answers with Markdown — a fenced code block and a doc
 * comment. Two things follow, and both were wrong the first time:
 *
 * 1. **The fence has to become a block.** Drawing the answer as text shows the
 *    reader ```typescript` and ```, which is the one thing a hover card must not do. The
 *    page's Markdown renderer does it (the `markdown` piece publishes one, §8);
 *    a page without that piece falls back to plain text.
 * 2. **The HTML it returns is already sanitised.** DOMPurify ran inside the
 *    publisher (the same call that draws a `.md` file). Escaping it again
 *    would show `&lt;` instead of `<`.
 *
 * Pure pieces live here rather than in the component so `node --test` can pin
 * them (a `.tsx` cannot be imported by the test runner, docs/m4/spec.md §12).
 */

/** The language a fence names, when the whole answer is one fence. */
export interface HoverBlock {
  language?: string
  code: string
}

/**
 * A hover's Markdown split into a language tag and the code it holds, when the
 * answer **is** one fenced block — the common case for a definition hover.
 * Anything else (prose, several blocks, a comment under the fence) comes back
 * as `undefined` and is rendered as a document instead.
 */
export function hoverBlock(contents: string): HoverBlock | undefined {
  const trimmed = contents.trim()
  if (!trimmed.startsWith('```')) return undefined
  const lines = trimmed.split('\n')
  const open = lines[0] ?? ''
  // The info string is whatever follows the opening fence on its own line.
  const language = open.slice(3).trim()
  // The block ends at the **first** closing fence: a second fence after it
  // means this is not "one block", it is a document.
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '```')
  if (close < 0) return undefined
  if (lines.length > close + 1) return undefined
  const code = lines.slice(1, close).join('\n')
  return language === '' ? { code } : { language, code }
}

/**
 * Whether an answer is worth showing at all. A server that has nothing to say
 * answers ```typescript`\n``` (an empty fence) — a card with an empty box is worse
 * than no card.
 */
export function hoverIsEmpty(contents: string): boolean {
  const block = hoverBlock(contents)
  if (block !== undefined) return block.code.trim() === ''
  return contents.trim() === ''
}
