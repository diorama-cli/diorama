/**
 * markdown — renders `.md` files as HTML (plan.md M1).
 *
 * Claims files by extension (`ext: ['md', …]`), so it wins the `ext` tier and
 * never runs for anything else. When this piece is not in the boot graph,
 * `.md` files fall through to `plaintext` (contract.md §5, fallback chain).
 *
 * Rendering is done in the browser from the text the kernel pre-read
 * (contract.md §5.1: renderers never do IO). The result is sanitised before it
 * reaches the DOM: a repository is untrusted input, and Markdown may carry raw
 * HTML.
 */
import type { Context } from 'cordis'
import { useMemo } from 'react'
import { provideEntry } from 'diorama-ui'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type {} from 'diorama-plugin-slots'
import type { FileRendererProps } from 'diorama-kernel'

export const name = 'markdown'
export const inject = ['slots']

/** Extensions this renderer claims (contract.md §5.1). */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx']

marked.setOptions({ gfm: true, breaks: false, async: false })

/** Markdown text → sanitised HTML. Pure, so it is safe to memoise. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  // A repository is untrusted input: no scripts, no event handlers, no
  // javascript: URLs, no inline styles that position over the page chrome.
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style'] })
}

function Markdown({ file, text }: FileRendererProps) {
  const html = useMemo(() => (text === undefined ? '' : renderMarkdown(text)), [text])
  return (
    <div className="diorama-markdown-wrap" data-testid="markdown">
      <div className="diorama-markdown__path">{file.path}</div>
      {text === undefined ? (
        <div className="diorama-renderer__empty" role="status" data-testid="markdown-binary">
          二进制文件，无法以 Markdown 渲染
        </div>
      ) : (
        <article
          className="diorama-markdown"
          data-path={file.path}
          // Sanitised above (DOMPurify); no plugin-authored HTML reaches the DOM.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
}

export function apply(ctx: Context) {
  provideEntry(ctx, {
      id: 'markdown:renderer',
      name: 'file.renderer',
      key: 'markdown',
      order: 100,
      matcher: { ext: [...MARKDOWN_EXTENSIONS] },
  }, Markdown)
}
