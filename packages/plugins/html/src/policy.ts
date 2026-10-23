/**
 * What the HTML preview allows (contract.md §5.1), in two stages:
 *
 * - **styles** (default): the page's own CSS in every form (`<style>`,
 *   `style=` attributes, external stylesheets), external styles, images and
 *   fonts. Scripts do **not** run.
 * - **scripts** (after the reader confirms, per file): as `styles`, plus the
 *   page's scripts — external and inline. The frame is rebuilt with
 *   `sandbox="allow-scripts"` and **without** `allow-same-origin`, so page
 *   script cannot reach the `diorama` page, its cookies or its files.
 *
 * Pure and DOM-free: the component renders the document this module builds, so
 * the policy is in one place and testable without a browser.
 */

/** What the preview is allowed to run. */
export type PreviewStage = 'styles' | 'scripts'

/** Extensions this renderer claims. One owner per extension (contract §5.1 rule 2). */
export const HTML_EXTENSIONS = ['html', 'htm'] as const

/** The two ways the `html` renderer shows a file. */
export type HtmlMode = 'preview' | 'source'

/** Remote schemes the styles stage may load; no `data:` documents, no `file:`. */
const REMOTE = 'https: http:'

/** The styles stage: the page's CSS and media, from anywhere. */
const CSP_STYLES = [
  "default-src 'none'",
  `style-src 'unsafe-inline' ${REMOTE}`,
  `img-src data: blob: ${REMOTE}`,
  `font-src data: ${REMOTE}`,
].join('; ')

/** The scripts stage: the above plus the page's own and external scripts. */
const CSP_SCRIPTS = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${REMOTE}`,
  `style-src 'unsafe-inline' ${REMOTE}`,
  `img-src data: blob: ${REMOTE}`,
  `font-src data: ${REMOTE}`,
  `connect-src ${REMOTE}`,
  `media-src data: blob: ${REMOTE}`,
].join('; ')

/**
 * The stage a preview is in, given what the reader (or `[html] scripts`, §4.1)
 * asked for and whether the page carries a script at all.
 *
 * A page with no script has nothing to confirm: it stays in the styles stage
 * (sanitised) even when the mount runs scripts by default — the scripts stage
 * exists to run scripts, and it deliberately skips the sanitiser.
 */
export function previewStage(trusted: boolean, scripted: boolean): PreviewStage {
  return trusted && scripted ? 'scripts' : 'styles'
}

/** The frame's `sandbox` per stage: never `allow-scripts` with `allow-same-origin`. */
export function frameSandbox(stage: PreviewStage): string {
  return stage === 'scripts' ? 'allow-scripts' : 'allow-same-origin'
}

/** The frame's CSP per stage. */
export function frameContentSecurityPolicy(stage: PreviewStage): string {
  return stage === 'scripts' ? CSP_SCRIPTS : CSP_STYLES
}

/**
 * The document the frame receives (`srcdoc`).
 *
 * `markup` is either the sanitised page (styles stage: scripts and inline
 * handlers removed) or the page's own source (scripts stage: sanitising would
 * strip the very scripts that were confirmed, and the sandbox is what contains
 * them). `head` carries the page's `<title>` (already escaped by the caller) so
 * a page keeps a meaningful name inside the frame.
 */
export function previewDocument(markup: string, stage: PreviewStage, head = ''): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${frameContentSecurityPolicy(stage)}">`,
    head,
    '</head><body>',
    markup,
    '</body></html>',
  ].join('')
}

/**
 * Whether the page carries a script at all — the only thing the confirmation
 * prompt is about. Plain substring check: it runs before sanitising and only
 * decides whether to offer the button (a false positive costs one prompt, a
 * false negative would silently drop the page's behaviour).
 */
export function hasScript(text: string): boolean {
  return /<script[\s>]/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text)
}

/** The page's `<title>`, escaped for the frame head (`''` when it has none). */
export function documentTitle(text: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)
  if (match === null) return ''
  return escapeHtml(decodeEntities(match[1] ?? '').trim())
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The handful of entities that show up in `<title>` elements. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Size for the header line (the same phrasing the other renderers use). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Lines in a text, counting a trailing newline as ending the last line. */
export function lineCount(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lines++
  return text.endsWith('\n') ? lines - 1 : lines
}
