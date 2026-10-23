/**
 * The browser half of math and diagrams: load the library **when a document
 * needs it**, then render the placeholders `math.ts` left in the HTML.
 *
 * Nothing here is bundled. KaTeX (~280 KB) and Mermaid (~3.5 MB) are files the
 * piece ships beside its client half and serves under
 * `/plugins/markdown/vendor/` (contract.md §5.1), so:
 *
 * - a document without math and without a `mermaid` fence downloads neither;
 * - the first document that has one pays for it **once per page** (a module
 *   level promise is the cache), not once per tab;
 * - KaTeX's stylesheet finds its 20 font files next to itself, unchanged.
 *
 * Rendering happens **after mount**, on the article the renderer just drew: the
 * sanitised HTML is in the DOM by then, and a formula is not markup the
 * sanitiser has to reason about (it is text in a `data-tex` attribute).
 *
 * The page is the only place this runs; `renderMarkdown` (pure) never touches
 * the DOM, which is why `node --test` can still exercise the parser.
 */

/** Where the piece's runtime files live (see `scripts/vendor.mjs`). */
const VENDOR_BASE = '/plugins/markdown/vendor'

/** The two globals the vendored scripts install. */
interface VendorGlobals {
  katex?: { render(tex: string, element: HTMLElement, options?: Record<string, unknown>): void }
  mermaid?: {
    initialize(config: Record<string, unknown>): void
    render(id: string, text: string): Promise<{ svg: string }>
  }
}

function globals(): VendorGlobals {
  return globalThis as unknown as VendorGlobals
}

/** One `<script>` per URL per page; a failed load is retried by the next call. */
const scriptLoads = new Map<string, Promise<void>>()

function loadScript(src: string): Promise<void> {
  const existing = scriptLoads.get(src)
  if (existing !== undefined) return existing
  const load = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => {
      script.remove()
      resolve()
    }
    script.onerror = () => {
      script.remove()
      scriptLoads.delete(src)
      reject(new Error('diorama markdown: could not load ' + src))
    }
    document.head.appendChild(script)
  })
  scriptLoads.set(src, load)
  return load
}

/** The stylesheet is a `<link>`; the browser dedupes by URL anyway. */
const STYLESHEET_ID = 'diorama-katex-styles'

function loadStylesheet(href: string): void {
  if (document.getElementById(STYLESHEET_ID) !== null) return
  const link = document.createElement('link')
  link.id = STYLESHEET_ID
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
}

let katexLoading: Promise<void> | undefined
let mermaidLoading: Promise<void> | undefined

/** Load KaTeX once (stylesheet + script); later calls await the same promise. */
export function loadKatex(): Promise<void> {
  if (globals().katex !== undefined) return Promise.resolve()
  if (katexLoading === undefined) {
    loadStylesheet(VENDOR_BASE + '/katex.min.css')
    katexLoading = loadScript(VENDOR_BASE + '/katex.min.js').catch(error => {
      katexLoading = undefined
      throw error
    })
  }
  return katexLoading
}

/** The scheme the page is painting with (`ctx.theme` writes the attribute). */
function scheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-scheme') === 'dark' ? 'dark' : 'light'
}

/** Load Mermaid once; the page's scheme decides the diagram theme. */
export function loadMermaid(): Promise<void> {
  if (globals().mermaid !== undefined) return Promise.resolve()
  if (mermaidLoading === undefined) {
    mermaidLoading = loadScript(VENDOR_BASE + '/mermaid.min.js')
      .then(() => {
        const mermaid = globals().mermaid
        mermaid?.initialize({
          startOnLoad: false,
          // The page's palette, not Mermaid's own light default: a dark page
          // holding a white diagram reads as a broken image.
          theme: scheme() === 'dark' ? 'dark' : 'default',
          securityLevel: 'strict',
          fontFamily: getComputedStyle(document.body).fontFamily,
        })
      })
      .catch(error => {
        mermaidLoading = undefined
        throw error
      })
  }
  return mermaidLoading
}

/** Whether an article carries something that needs KaTeX. */
export function hasMath(root: ParentNode): boolean {
  return root.querySelector('[data-math]') !== null
}

/** Whether an article carries something that needs Mermaid. */
export function hasMermaid(root: ParentNode): boolean {
  return root.querySelector('[data-mermaid]') !== null
}

/**
 * Render every formula under `root`. Idempotent per element (`data-rendered`),
 * and a formula KaTeX refuses keeps its escaped TeX as its text: a typo in a
 * document must not blank the paragraph around it.
 */
export function renderMath(root: ParentNode): void {
  const katex = globals().katex
  if (katex === undefined) return
  for (const element of root.querySelectorAll<HTMLElement>('[data-math]')) {
    if (element.dataset.rendered === 'true') continue
    // The TeX is the placeholder's **text** (never an attribute: DOMPurify
    // drops a value containing `-->`, and a diagram is full of it).
    const tex = element.textContent ?? ''
    element.dataset.rendered = 'true'
    try {
      katex.render(tex, element, {
        displayMode: element.dataset.math === 'block',
        throwOnError: false,
        strict: 'ignore',
      })
    } catch {
      // `throwOnError: false` already renders the TeX in red; this is the
      // "KaTeX itself threw" case, where the placeholder text stays.
    }
  }
}

/** One counter per page, so two diagrams never share a Mermaid render id. */
let diagramSeq = 0

/**
 * Render every diagram under `root`. Mermaid's renderer is async and parses
 * the source; a source it cannot read leaves the `<pre>` (the document's own
 * text) in place with a note, which is what a reader needs to fix it.
 */
export async function renderMermaid(root: ParentNode): Promise<void> {
  const mermaid = globals().mermaid
  if (mermaid === undefined) return
  for (const element of root.querySelectorAll<HTMLElement>('[data-mermaid]')) {
    if (element.dataset.rendered === 'true') continue
    // Same rule as the formulas: the source is text, read back from the
    // `<pre><code>` the placeholder carries.
    const source = element.querySelector('code')?.textContent ?? element.textContent ?? ''
    element.dataset.rendered = 'true'
    try {
      const { svg } = await mermaid.render('diorama-mermaid-' + ++diagramSeq, source)
      element.innerHTML = svg
      element.dataset.state = 'rendered'
    } catch (error) {
      element.dataset.state = 'error'
      element.title = error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Make one article whole: load what it needs (in parallel), then render.
 *
 * Returns a disposer. The caller (the renderer) runs this once per document; a
 * document swapped underneath the same article re-runs it, and the disposer
 * only has to cancel the pending work of the previous run.
 */
export function enhanceArticle(article: HTMLElement): () => void {
  let cancelled = false
  const math = hasMath(article)
  const diagrams = hasMermaid(article)
  if (!math && !diagrams) return () => {}
  const mathWork = math
    ? loadKatex().then(() => {
        if (!cancelled) renderMath(article)
      })
    : Promise.resolve()
  const diagramWork = diagrams
    ? loadMermaid().then(() => {
        if (cancelled) return
        return renderMermaid(article)
      })
    : Promise.resolve()
  void Promise.all([mathWork.catch(report), diagramWork.catch(report)])
  return () => {
    cancelled = true
  }
}

function report(error: unknown): void {
  console.warn('[diorama] markdown: enhancement failed:', error instanceof Error ? error.message : error)
}

/**
 * Re-theme diagrams when the page's scheme changes. Mermaid bakes its colours
 * into the SVG, so a switch has to re-render; the alternative is a dark page
 * holding a white diagram. Returns the observer's disposer.
 */
export function watchScheme(onChange: () => void): () => void {
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.attributeName === 'data-scheme') {
        onChange()
        return
      }
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme'] })
  return () => observer.disconnect()
}

/** Re-render every diagram in a new scheme (the observer's action). */
export async function rethemeMermaid(root: ParentNode): Promise<void> {
  if (!hasMermaid(root) || globals().mermaid === undefined) return
  for (const element of root.querySelectorAll<HTMLElement>('[data-mermaid]')) {
    element.dataset.rendered = 'false'
    element.dataset.state = 'stale'
  }
  await renderMermaid(root)
}
