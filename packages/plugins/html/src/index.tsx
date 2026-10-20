/**
 * html — renders `.html` / `.htm` files (contract.md §5.1).
 *
 * Two modes, switched in the renderer's own header (no toolbar; O8):
 *
 * - **preview** (default): the kernel pre-reads the text (contract §5.1), it is
 *   sanitised with DOMPurify — scripts, event handlers, `<style>`, nested
 *   frames and network-capable elements removed — and the result goes into a
 *   `<iframe srcdoc sandbox="allow-same-origin">`. A repository is untrusted
 *   input; the frame cannot run a script, and what survives the sanitiser is
 *   ordinary markup and CSS that the browser lays out natively.
 * - **source**: the file's own text in a `<pre>`, escaped (never interpreted).
 *   `code` does not claim `.html` (contract §5.1 rule 2: one owner per
 *   extension), so the source view lives here.
 *
 * The mode belongs to the renderer instance (one per tab seat): a different
 * file in the same tab — a deep link, a restored tab — starts in preview, so
 * opening a page always looks like the page.
 */
import type { Context } from 'cordis'
import { useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import type {} from 'diorama-plugin-slots'
import type { FileRendererProps } from 'diorama-kernel'
import { provideEntry } from 'diorama-ui'
import { formatSize, HTML_EXTENSIONS, lineCount, type HtmlMode } from './frame.ts'

export const name = 'html'
export const inject = ['slots']

export type { HtmlMode } from './frame.ts'
export { formatSize, HTML_EXTENSIONS, lineCount } from './frame.ts'

/** The frame's policy: no fetch of any kind, and no stylesheet at all. */
const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'none'"

/**
 * The document the preview frame receives (`srcdoc`). Markup only — no
 * `<style>` and no nonce: a Chromium-sandboxed frame does not propagate a
 * nonce to its styles or scripts, so the sanitiser (not a nonce) is what keeps
 * page styles out, and this policy keeps everything else out.
 */
export function previewDocument(markup: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    '</head><body>',
    markup,
    '</body></html>',
  ].join('')
}

/**
 * Sanitise a page for the preview: the markdown policy, plus the elements that
 * would either start another browsing context (`form`, `iframe`, `object`,
 * `embed`) or restyle the viewer once the markup is in a document of its own
 * (`style`). Content that needs them still has the source view.
 */
export function sanitizeHtml(text: string): string {
  return DOMPurify.sanitize(text, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    FORBID_TAGS: ['style', 'form', 'iframe', 'frame', 'frameset', 'object', 'embed'],
    FORBID_ATTR: ['srcdoc', 'ping'],
  })
}

export function HtmlRenderer({ file, text }: FileRendererProps) {
  // The seat keeps the component mounted across file changes; another file in
  // the same tab starts from the top (preview).
  const [state, setState] = useState<{ path: string; mode: HtmlMode }>({ path: file.path, mode: 'preview' })
  const mode: HtmlMode = state.path === file.path ? state.mode : 'preview'
  const setMode = (next: HtmlMode): void => setState({ path: file.path, mode: next })
  const safe = useMemo(() => (text === undefined ? '' : sanitizeHtml(text)), [text])
  const document = useMemo(() => previewDocument(safe), [safe])

  return (
    <div className="diorama-html" data-testid="html" data-mode={mode}>
      <div className="diorama-html__bar">
        <span className="diorama-html__path" title={file.path}>
          {file.path}
        </span>
        <span className="diorama-html__meta">
          {formatSize(file.size)}
          {text === undefined ? '' : ` · ${lineCount(text)} 行`}
        </span>
        <div className="diorama-html__modes" role="group" aria-label="显示方式">
          <button
            type="button"
            aria-pressed={mode === 'preview'}
            data-testid="html-mode-preview"
            onClick={() => setMode('preview')}
          >
            预览
          </button>
          <button
            type="button"
            aria-pressed={mode === 'source'}
            data-testid="html-mode-source"
            onClick={() => setMode('source')}
          >
            源码
          </button>
        </div>
      </div>
      {mode === 'preview' ? (
        <iframe
          className="diorama-html__frame"
          data-testid="html-frame"
          title={`${file.path} 预览`}
          // Sanitised above; without `allow-scripts` the frame cannot run a
          // script even if the markup carried one.
          srcDoc={document}
          sandbox="allow-same-origin"
        />
      ) : (
        <pre className="diorama-html__source" data-testid="html-source">
          {/* Text nodes: React escapes them, so the markup is never interpreted. */}
          <code>{text ?? ''}</code>
        </pre>
      )}
    </div>
  )
}

export function apply(ctx: Context) {
  provideEntry(ctx, {
    id: 'html:renderer',
    name: 'file.renderer',
    key: 'html',
    order: 90,
    matcher: { ext: [...HTML_EXTENSIONS] },
  }, HtmlRenderer)
}
