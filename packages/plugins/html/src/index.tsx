/**
 * html — renders `.html` / `.htm` files (contract.md §5.1).
 *
 * Views, switched in the renderer's own header (no toolbar; O8):
 *
 * - **preview** (default): the kernel pre-reads the text, and it is shown in a
 *   sandboxed `<iframe srcdoc>` under the policy in `policy.ts`. The page keeps
 *   its own CSS (inline, `style=`, external stylesheets) and its external
 *   images; its **scripts do not run** unless the reader confirms, per file.
 *   A page that carries a script gets a bar saying so with a "run scripts"
 *   button; confirming rebuilds the frame with `allow-scripts` and no
 *   `allow-same-origin`, so the page runs but cannot reach this page, its
 *   cookies or its files.
 * - **source**: the file's own text in a `<pre>`, escaped (never interpreted).
 *   `code` does not claim `.html` (contract §5.1 rule 2: one owner per
 *   extension), so the source view lives here.
 *
 * Both modes and the confirmation belong to the renderer instance (one per tab
 * seat): another file in the same tab — a deep link, a restored tab — starts
 * over, unconfirmed, so "trusted" never travels to a file nobody looked at.
 */
import type { Context } from 'cordis'
import { useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import type {} from 'diorama-plugin-slots'
import type { FileRendererProps } from 'diorama-kernel'
import { provideEntry } from 'diorama-ui'
import { formatSize, HTML_EXTENSIONS, lineCount, type HtmlMode } from './frame.ts'
import { documentTitle, hasScript, previewDocument, type PreviewStage } from './policy.ts'

export const name = 'html'
export const inject = ['slots']

export type { HtmlMode } from './frame.ts'
export { formatSize, HTML_EXTENSIONS, lineCount } from './frame.ts'
export type { PreviewStage } from './policy.ts'

/**
 * Sanitise a page for the **styles** stage: the markdown policy, plus the
 * elements that start another browsing context (`form`, `iframe`, `object`,
 * `embed`). Styles stay: `<style>` and `style=` are the page's own look, and
 * the frame is where they belong. Scripts never reach this stage.
 *
 * `WHOLE_DOCUMENT` matters: without it DOMPurify sanitises the **body only**
 * and silently drops everything a page puts in `<head>` — including the
 * `<style>` block that carries its whole look. The caller passes a document
 * with a head so the page's `<style>`/`<title>` survive.
 */
export function sanitizeHtml(text: string): string {
  const document = /<html[\s>]/i.test(text) ? text : `<!doctype html><html><head></head><body>${text}</body></html>`
  return DOMPurify.sanitize(document, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    FORBID_TAGS: ['form', 'iframe', 'frame', 'frameset', 'object', 'embed'],
    FORBID_ATTR: ['srcdoc', 'ping'],
    WHOLE_DOCUMENT: true,
  })
}

/** The `<head>` of sanitised markup (`''` when it has none). */
function headOf(markup: string): string {
  const match = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(markup)
  return match?.[1] ?? ''
}

/** The `<body>` of sanitised markup, or the whole thing when it has no body. */
function bodyOf(markup: string): string {
  const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(markup)
  return match?.[1] ?? markup
}

export function HtmlRenderer({ file, text }: FileRendererProps) {
  // The seat keeps the component mounted across file changes; another file in
  // the same tab starts from the top: preview, and scripts unconfirmed.
  const [state, setState] = useState<{ path: string; mode: HtmlMode; trusted: boolean }>({
    path: file.path,
    mode: 'preview',
    trusted: false,
  })
  const current = state.path === file.path ? state : { path: file.path, mode: 'preview' as HtmlMode, trusted: false }
  const setMode = (mode: HtmlMode): void => setState({ ...current, mode })
  const trust = (): void => setState({ ...current, mode: 'preview', trusted: true })
  const revoke = (): void => setState({ ...current, trusted: false })

  const stage: PreviewStage = current.trusted ? 'scripts' : 'styles'
  const scripted = text !== undefined && hasScript(text)
  const document = useMemo(() => {
    if (text === undefined) return ''
    // The scripts stage must keep the page's script elements: sanitising would
    // strip exactly what was confirmed. The sandbox and CSP contain them.
    if (stage === 'scripts') return previewDocument(text, stage, '')
    const clean = sanitizeHtml(text)
    const title = documentTitle(text)
    const head = headOf(clean).trim()
    const extra = [title === '' ? '' : `<title>${title}</title>`, head].filter(part => part !== '').join('')
    return previewDocument(bodyOf(clean), stage, extra)
  }, [text, stage])

  return (
    <div className="diorama-html" data-testid="html" data-mode={current.mode} data-stage={stage}>
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
            aria-pressed={current.mode === 'preview'}
            data-testid="html-mode-preview"
            onClick={() => setMode('preview')}
          >
            预览
          </button>
          <button
            type="button"
            aria-pressed={current.mode === 'source'}
            data-testid="html-mode-source"
            onClick={() => setMode('source')}
          >
            源码
          </button>
        </div>
      </div>
      {current.mode === 'preview' ? (
        <>
          {scripted ? (
            <div className="diorama-html__script" role="status" data-testid="html-script-notice">
              {stage === 'scripts' ? (
                <>
                  <span>已执行页面脚本（页面内运行，读不到本页与你的文件）。</span>
                  <button type="button" data-testid="html-script-revoke" onClick={revoke}>
                    停止执行
                  </button>
                </>
              ) : (
                <>
                  <span>此页面含脚本，预览中未执行。</span>
                  <button type="button" data-testid="html-script-run" onClick={trust}>
                    执行脚本并预览
                  </button>
                </>
              )}
            </div>
          ) : null}
          <iframe
            className="diorama-html__frame"
            data-testid="html-frame"
            title={`${file.path} 预览`}
            // A new key per stage: confirming must build a fresh frame, not
            // re-render one whose scripts already ran (or did not).
            key={stage}
            srcDoc={document}
            sandbox={stage === 'scripts' ? 'allow-scripts' : 'allow-same-origin'}
          />
        </>
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
