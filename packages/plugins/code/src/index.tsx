/**
 * code — syntax-highlighted source files (plan.md M1).
 *
 * Claims textual source/config files by extension and renders them with
 * highlight.js. Languages are registered explicitly: the full highlight.js
 * bundle is ~1 MB, and a viewer needs a handful of common ones.
 *
 * Highlighting is done in the browser from the text the kernel pre-read; the
 * markup comes from highlight.js itself (no repository HTML is interpreted).
 *
 * This half also **publishes the engine** on the page (`__diorama_highlight__`,
 * see `diorama-ui`'s `highlight.ts`): the diff readers of `git-changes` colour
 * their rows with the same languages, and a client half cannot import another
 * half (each is its own build). One registration list, two readers.
 */
import type { Context } from 'cordis'
import { useMemo, useRef } from 'react'
import { provideEntry, publishHighlighter, useRevealLine } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'
import type { FileRendererProps } from 'diorama-kernel'
import { CODE_EXTENSIONS, CODE_LANGUAGES, escapeHtml, highlight, highlightLines, languageOf } from './highlight.ts'

export const name = 'code'
export const inject = ['slots']

export { CODE_EXTENSIONS, CODE_LANGUAGES, escapeHtml, highlight, highlightLines, languageOf }

function Code({ file, text }: FileRendererProps) {
  const result = useMemo(() => highlight(text ?? '', file.path), [text, file.path])
  // A search hit opens the file at its line (contract.md §3.9): the reveal
  // store says which one, and this `<pre>` is what scrolls there.
  const pre = useRef<HTMLPreElement | null>(null)
  const revealed = useRevealLine(file.path, pre)
  return (
    <div className="diorama-code-wrap" data-testid="code" data-language={result.language}>
      <div className="diorama-code__path">{file.path}</div>
      {text === undefined ? (
        <div className="diorama-renderer__empty" role="status" data-testid="code-binary">
          二进制文件，无法高亮
        </div>
      ) : (
        <pre className="diorama-code" ref={pre}>
          {/* highlight.js escapes its input; this markup is generated, not copied. */}
          <code dangerouslySetInnerHTML={{ __html: result.html }} />
          {revealed === undefined ? null : (
            <span
              className="diorama-code__reveal"
              data-testid="code-reveal"
              data-line={revealed.line}
              aria-hidden="true"
              style={{ top: revealed.top, height: revealed.height }}
            />
          )}
        </pre>
      )}
    </div>
  )
}

export function apply(ctx: Context) {
  // The engine every diff reader of this page colours its rows with. Disposing
  // this piece takes it back off the page (another publisher is left alone).
  ctx.effect(
    () => publishHighlighter({ languageOf, lines: highlightLines }),
    'code: publish the highlighter',
  )
  provideEntry(ctx, {
      id: 'code:renderer',
      name: 'file.renderer',
      key: 'code',
      order: 200,
      matcher: { ext: CODE_EXTENSIONS },
  }, Code)
}
