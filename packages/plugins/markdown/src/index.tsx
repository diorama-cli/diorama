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
 */
import type { Context } from 'cordis'
import { useCallback, useMemo, type MouseEvent } from 'react'
import { provideEntry, useKernel } from 'diorama-ui'
import DOMPurify from 'dompurify'
import { Marked, Renderer } from 'marked'
import type { Tokens } from 'marked'
import type {} from 'diorama-plugin-slots'
import type { FileInfo, FileRendererProps, MountHandle } from 'diorama-kernel'
import { classifyLink, headingSlug, uniqueHeadingId } from './links.ts'

export const name = 'markdown'
export const inject = ['slots']

/** Extensions this renderer claims (contract.md §5.1). */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx']

/**
 * The parser: one private `Marked` instance, so this piece's heading ids never
 * touch the shared default instance (which other code may configure). Its
 * counters are per instance and reset by {@link renderMarkdown}, which is what
 * makes the ids stable for one document.
 */
const parser = new Marked({ gfm: true, breaks: false, async: false })

/**
 * A renderer that gives every heading an `id`, so a `#section` link inside a
 * document has somewhere to land. The counters live in the closure: one
 * renderer per parse (see {@link renderMarkdown}).
 */
function headingIdRenderer(): Renderer {
  const seen = new Map<string, number>()
  const renderer = new Renderer()
  renderer.heading = function (token: Tokens.Heading): string {
    const text = this.parser.parseInline(token.tokens)
    const id = uniqueHeadingId(headingSlug(text), seen)
    return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`
  }
  return renderer
}

/**
 * Markdown text → sanitised HTML. Pure, so it is safe to memoise.
 *
 * The renderer is passed **per call**: registering it on the instance would
 * accumulate one copy per keystroke (`use` merges, it does not replace), and
 * the heading counters have to start over for each document.
 */
export function renderMarkdown(text: string): string {
  const html = parser.parse(text, { async: false, renderer: headingIdRenderer() })
  // A repository is untrusted input: no scripts, no event handlers, no
  // javascript: URLs, no inline styles that position over the page chrome.
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style'],
    // `id` is what the heading anchors point at. DOMPurify allows it already;
    // naming it keeps a version bump from quietly taking the anchors away.
    ADD_ATTR: ['id'],
  })
}

/** A `FileInfo` for a path (a tab carries the path only, contract.md §3.4). */
function fileOf(path: string): FileInfo {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 0, mtime: 0 }
}

/**
 * Scroll to a heading of the article on screen.
 *
 * A link to another file's heading arrives before that file is rendered, so a
 * miss waits a few frames for the article to be replaced and then gives up
 * quietly (a dead anchor is not an error worth a dialog).
 */
function scrollToHeading(id: string): void {
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

function Markdown({ file, text, mountCtx }: FileRendererProps) {
  const html = useMemo(() => (text === undefined ? '' : renderMarkdown(text)), [text])
  // The page's services: `tabs` / `router` are provided by pieces, so they are
  // read through the page context (a renderer gets `mountCtx`, not `ctx`).
  const { ctx } = useKernel()
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
        scrollToHeading(target.id)
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
          onClick={onClick}
        />
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
