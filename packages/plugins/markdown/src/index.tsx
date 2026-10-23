/**
 * markdown — renders `.md` files as HTML (plan.md M1), with an outline, math
 * and diagrams (contract.md §5.1).
 *
 * Claims files by extension (`ext: ['md', …]`), so it wins the `ext` tier and
 * never runs for anything else. When this piece is not in the boot graph,
 * `.md` files fall through to `plaintext` (contract.md §5, fallback chain).
 *
 * Rendering is done in the browser from the text the kernel pre-read
 * (contract.md §5.1: renderers never do IO). The result is sanitised before it
 * reaches the DOM: a repository is untrusted input, and Markdown may carry raw
 * HTML.
 *
 * **Links stay inside the page** (docs/m12/spec.md, contract.md §5.1). A
 * rendered `href` is written relative to the *file* (`docs/notes.md`,
 * `../README.md`), while the page's URL is a route (`/~/<RelPath>`,
 * contract.md §3.8); letting the browser follow one navigates the whole page,
 * which loses every open tab — the tab set is not in the URL. So a click is
 * classified before it reaches the browser (`links.ts`): a file of this mount
 * opens in a tab, a `#fragment` scrolls to that heading, another origin or
 * scheme opens in a new browser tab, and a path that would leave the mount is
 * refused.
 *
 * **Math and diagrams are placeholders until mount.** The parser emits a
 * `data-math` / `data-mermaid` element carrying the source (`math.ts`); the
 * renderer hands the article to `enhance.ts`, which loads KaTeX or Mermaid
 * **the first time a document needs them** and renders in place. Neither
 * library is in this half's bundle: both are served from the piece's own
 * package (`/plugins/markdown/vendor/`, contract.md §5.1).
 *
 * **The outline belongs to the document, not to the page.** Every heading
 * already gets an `id` (a `#fragment` link has to land somewhere); the same
 * list is drawn as a rail beside *this* article, inside this tab. It is not a
 * view of the left column: one file's headings are not a fact about the
 * mount, and the column is shared by every tab (contract.md §5.1).
 */
import type { Context } from 'cordis'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { provideEntry, useKernel } from 'diorama-ui'
import DOMPurify from 'dompurify'
import { Marked, Renderer } from 'marked'
import type { Tokens } from 'marked'
import type {} from 'diorama-plugin-slots'
import type { FileInfo, FileRendererProps, MountHandle } from 'diorama-kernel'
import { classifyLink, headingSlug, uniqueHeadingId } from './links.ts'
import { enhanceArticle, rethemeMermaid, watchScheme } from './enhance.ts'
import { isMermaidFence, mathExtension, mermaidPlaceholder } from './math.ts'
import { normalizeOutline, OUTLINE_MIN_HEADINGS, plainHeadingText, type OutlineEntry } from './outline.ts'

export const name = 'markdown'
export const inject = ['slots']

/** Extensions this renderer claims (contract.md §5.1). */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx']

/**
 * The parser: one private `Marked` instance, so this piece's heading ids never
 * touch the shared default instance (which other code may configure). Its
 * counters are per instance and reset by {@link renderDocument}, which is what
 * makes the ids stable for one document.
 *
 * The math extension is registered **once**, on the instance: `use` merges
 * extensions, so registering it per call would append a copy per keystroke
 * (the same trap the heading renderer avoids by being passed per call).
 */
const parser = new Marked({ gfm: true, breaks: false, async: false }, mathExtension())

/**
 * A renderer that gives every heading an `id` (a `#section` link inside a
 * document has to land somewhere), collects the outline, and turns a
 * ```mermaid fence into a placeholder. The counters and the outline live in the
 * closure: one renderer per parse (see {@link renderDocument}).
 */
function documentRenderer(outline: OutlineEntry[]): Renderer {
  const seen = new Map<string, number>()
  const renderer = new Renderer()
  renderer.heading = function (token: Tokens.Heading): string {
    const text = this.parser.parseInline(token.tokens)
    const id = uniqueHeadingId(headingSlug(text), seen)
    outline.push({ depth: token.depth, id, text: plainHeadingText(text) })
    return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`
  }
  renderer.code = function (token: Tokens.Code): string {
    // A diagram is not code: Mermaid reads it, and the `<pre>` inside the
    // placeholder is what a reader sees if it never loads.
    if (isMermaidFence(token.lang)) return mermaidPlaceholder(token.text)
    // Everything else is the base renderer's job (escaping included).
    return Renderer.prototype.code.call(this, token)
  }
  return renderer
}

/**
 * Markdown text → sanitised HTML plus the document's outline. Pure, so it is
 * safe to memoise, and it is what `node --test` exercises.
 *
 * The renderer is passed **per call**: registering it on the instance would
 * accumulate one copy per keystroke (`use` merges, it does not replace), and
 * the heading counters have to start over for each document.
 */
export function renderDocument(text: string): { html: string; outline: OutlineEntry[] } {
  const outline: OutlineEntry[] = []
  const html = parser.parse(text, { async: false, renderer: documentRenderer(outline) })
  // A repository is untrusted input: no scripts, no event handlers, no
  // javascript: URLs, no inline styles that position over the page chrome.
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style'],
    // `id` is what the heading anchors point at. DOMPurify allows it already;
    // naming it keeps a version bump from quietly taking the anchors away.
    ADD_ATTR: ['id'],
    // The placeholders are marked with `data-math` / `data-mermaid` (`math.ts`).
    // Their *source* is text content, not an attribute: DOMPurify drops an
    // attribute whose value contains `-->`, and a Mermaid diagram is full of
    // it. Naming the rule keeps a version bump from taking the markers away.
    ALLOW_DATA_ATTR: true,
  })
  return { html: clean, outline: normalizeOutline(outline) }
}

/** Markdown text → sanitised HTML (the outline is dropped). */
export function renderMarkdown(text: string): string {
  return renderDocument(text).html
}

/** A `FileInfo` for a path (a tab carries the path only, contract.md §3.4). */
function fileOf(path: string): FileInfo {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 0, mtime: 0 }
}

/** One heading element's `id` inside a subtree (the CSS-escaped selector). */
function headingIn(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
}

/**
 * Scroll to a heading **of this article** — what an outline row does.
 *
 * Scoped to the article on purpose: every open tab keeps its own mounted
 * article (contract.md §5), so a document-wide query would find the first
 * match, which may be a hidden tab's copy of the same `id`.
 */
function scrollArticleTo(article: HTMLElement | null, id: string): void {
  if (article === null) return
  const found = headingIn(article, id)
  if (found !== null) found.scrollIntoView({ block: 'start' })
}

/**
 * Scroll to a heading named by a **link** (`#fragment`, or `other.md#part`).
 *
 * A link to another file's heading arrives before that file is rendered, so a
 * miss waits a few frames for the article to be replaced and then gives up
 * quietly (a dead anchor is not an error worth a dialog). This one is
 * document-wide because the target may be another tab's article.
 */
export function scrollToHeading(id: string): void {
  const find = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.diorama-markdown [id="${CSS.escape(id)}"]`)
  const found = find()
  if (found !== null) {
    found.scrollIntoView({ block: 'start' })
    return
  }
  let frames = 0
  const tick = (): void => {
    const next = find()
    if (next !== null) {
      next.scrollIntoView({ block: 'start' })
      return
    }
    if (frames++ < 30) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
/**
 * The document a directory link should show: its `README` / `index` when it has
 * one, else `undefined` (a directory is not a tab, and opening one has no
 * content to draw — the file tree is what navigates directories).
 *
 * A case-insensitive name match, because a repository is free to write
 * `Readme.md`; the extension is limited to Markdown on purpose, so the choice
 * stays predictable rather than "whatever lists first".
 */
async function directoryIndex(mount: MountHandle, dir: string): Promise<string | undefined> {
  try {
    const entries = await mount.fs.list(dir)
    const hit = entries.find(
      entry => entry.kind === 'file' && /^(readme|index)\.mdx?$/i.test(entry.name),
    )
    return hit?.path
  } catch {
    return undefined
  }
}

/**
 * Open a mount path in the page: the router first (the kernel's own "show this
 * file", which also refuses paths outside the mount, contract.md §3.8), the tab
 * service when there is no router.
 *
 * The `stat` is what tells a directory from a file: a directory has no tab, so
 * a link to one opens its `README`/`index` (see {@link directoryIndex}) or does
 * nothing. A missing file still opens — the content seat explains the error
 * (contract.md §3.8) — which is also why a failed `stat` is not a refusal.
 */
async function openPath(
  services: { tabs?: { open(file: FileInfo): unknown }; router?: { open(path: string): boolean } },
  mount: MountHandle,
  path: string,
  anchor: string | undefined,
): Promise<void> {
  let target = path
  try {
    if ((await mount.fs.stat(path)).kind === 'dir') {
      const index = await directoryIndex(mount, path)
      if (index === undefined) return
      target = index
    }
  } catch {
    // Not there (or not readable): let the content seat say so.
  }
  if (services.router?.open(target) !== true) services.tabs?.open(fileOf(target))
  if (anchor !== undefined) scrollToHeading(anchor)
}

/**
 * The outline rail beside one document: its headings, indented by level, each a
 * button that scrolls this article to that heading.
 *
 * It is part of the renderer, not a view of the left column: the headings are a
 * fact about **this file**, and the column is shared by every tab. It draws
 * nothing below {@link OUTLINE_MIN_HEADINGS} — a single heading is the title the
 * reader can already see, and a rail for it would only take width from the text.
 *
 * The current section is marked by a scroll listener rather than an
 * `IntersectionObserver`: the article scrolls inside the tab's own box
 * (contract.md §5), and the heading that is "current" is the last one above the
 * top edge — a comparison, not an intersection.
 */
function OutlineRail({
  entries,
  article,
}: {
  entries: readonly OutlineEntry[]
  article: React.RefObject<HTMLElement | null>
}) {
  const [current, setCurrent] = useState<string | undefined>(undefined)
  // Which heading is at the top of the reading area. Re-read on scroll and
  // whenever the document changes (a new file starts at its first heading).
  useEffect(() => {
    const element = article.current
    if (element === null) return
    const scroller = element.closest<HTMLElement>('.diorama-tabs__content')
    const read = (): void => {
      // The reading line sits a little **below** where a heading lands when it is
      // scrolled to: `scroll-margin-top: 8px` (the stylesheet) puts it 8px under
      // the edge, so a line at exactly 8px leaves the heading just jumped to on
      // the wrong side of the comparison — and floating point decides which.
      const box = scroller?.getBoundingClientRect()
      const top = (box?.top ?? 0) + 24
      let found: string | undefined
      for (const entry of entries) {
        const heading = headingIn(element, entry.id)
        if (heading === null) continue
        if (heading.getBoundingClientRect().top <= top) found = entry.id
        else break
      }
      setCurrent(found ?? entries[0]?.id)
    }
    read()
    const target = scroller ?? element
    target.addEventListener('scroll', read, { passive: true })
    return () => target.removeEventListener('scroll', read)
  }, [article, entries])
  return (
    <nav className="diorama-outline" aria-label="大纲" data-testid="outline">
      <div className="diorama-outline__title">大纲</div>
      {entries.map(entry => (
        <button
          key={entry.id}
          type="button"
          className={`diorama-outline__row${entry.id === current ? ' diorama-outline__row--current' : ''}`}
          data-depth={entry.depth}
          data-target={entry.id}
          title={entry.text}
          aria-current={entry.id === current ? 'location' : undefined}
          style={{ paddingLeft: `${8 + (entry.depth - 1) * 12}px` }}
          onClick={() => scrollArticleTo(article.current, entry.id)}
        >
          {entry.text}
        </button>
      ))}
    </nav>
  )
}
function Markdown({ file, text, mountCtx }: FileRendererProps) {
  const document = useMemo(() => (text === undefined ? { html: '', outline: [] } : renderDocument(text)), [text])
  const article = useRef<HTMLElement | null>(null)
  // The page's services: `tabs` / `router` are provided by pieces, so they are
  // read through the page context (a renderer gets `mountCtx`, not `ctx`).
  const { ctx } = useKernel()
  // Math and diagrams are rendered on the live DOM, after the sanitised HTML
  // is in place. The effect depends on the document, so a file change re-runs
  // it; the previous run's pending work is cancelled.
  useEffect(() => {
    const element = article.current
    if (element === null) return
    return enhanceArticle(element)
  }, [document])
  // Mermaid bakes colours into the SVG: a scheme switch re-renders it, or a
  // dark page keeps a white diagram.
  useEffect(() => {
    const element = article.current
    if (element === null) return
    return watchScheme(() => {
      void rethemeMermaid(element)
    })
  }, [])
  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      // A modified click (new tab, download, selection) stays the browser's.
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = (event.target as Element | null)?.closest?.('a')
      if (link === null || link === undefined) return
      const href = link.getAttribute('href')
      if (href === null) return
      const target = classifyLink(href, file.path)
      // Every case is handled here: the browser must not navigate away.
      event.preventDefault()
      if (target.kind === 'external') {
        window.open(href, '_blank', 'noopener,noreferrer')
        return
      }
      if (target.kind === 'anchor') {
        // A fragment link in this document: scroll this article, not
        // whichever article happens to hold the first match.
        scrollArticleTo(article.current, target.id)
        return
      }
      if (target.kind === 'invalid') return
      void openPath(
        {
          tabs: readService<{ open(file: FileInfo): unknown }>(ctx, 'tabs'),
          router: readService<{ open(path: string): boolean }>(ctx, 'router'),
        },
        mountCtx,
        target.path,
        target.anchor,
      )
    },
    [ctx, file.path, mountCtx],
  )
  const outline = document.outline
  const showOutline = text !== undefined && outline.length >= OUTLINE_MIN_HEADINGS
  return (
    <div className="diorama-markdown-wrap" data-testid="markdown">
      <div className="diorama-markdown__path">{file.path}</div>
      {text === undefined ? (
        <div className="diorama-renderer__empty" role="status" data-testid="markdown-binary">
          二进制文件，无法以 Markdown 渲染
        </div>
      ) : (
        <div className={`diorama-markdown-body${showOutline ? ' diorama-markdown-body--outlined' : ''}`}>
          <article
            ref={article}
            className="diorama-markdown"
            data-path={file.path}
            // Sanitised above (DOMPurify); no plugin-authored HTML reaches the DOM.
            dangerouslySetInnerHTML={{ __html: document.html }}
            onClick={onClick}
          />
          {showOutline ? <OutlineRail entries={outline} article={article} /> : null}
        </div>
      )}
    </div>
  )
}

/**
 * One of the page's services, or `undefined`. Cordis throws when a property
 * that was never injected is read (AGENTS §5), so a renderer — which is also
 * loaded as this piece's server half — asks instead of assuming.
 */
function readService<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
  } catch {
    return undefined
  }
}

export function apply(ctx: Context) {
  provideEntry(
    ctx,
    {
      id: 'markdown:renderer',
      name: 'file.renderer',
      key: 'markdown',
      order: 100,
      matcher: { ext: [...MARKDOWN_EXTENSIONS] },
    },
    Markdown,
  )
}
