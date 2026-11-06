/**
 * The page's **Markdown renderer**, shared the way the highlighter is
 * (contract.md §5.1, §8).
 *
 * ## Why a page global
 *
 * A hover card holds Markdown: a language server answers with a fenced code
 * block and a doc comment (`(alias) add(a, b)` …). Drawing that as plain text
 * shows the reader the fence markers, which is the one thing a hover card must
 * not do.
 *
 * The piece that knows how to turn Markdown into **sanitised** HTML is the
 * `markdown` renderer, and it cannot be imported: every client half is its own
 * build (docs/m0/spec.md §10.3), so an import would be a second copy of
 * marked + DOMPurify in a second bundle — and, worse, a second set of
 * sanitising rules that could drift from the one that draws documents.
 *
 * So `markdown` **publishes** its own `renderMarkdown` here at boot and every other
 * piece reads it off the page. A page booted without that piece gets
 * `undefined` and draws the hover text as text — the honest fallback, not a
 * second implementation.
 *
 * ## The HTML is already clean
 *
 * Whatever the publisher returns has been through DOMPurify (the same call
 * that draws a `.md` file). Callers must not add their own escaping on top:
 * that would show `&lt;` instead of `<`.
 */
import { useSyncExternalStore } from 'react'

/** Markdown → sanitised HTML, one document. */
export type MarkdownRenderer = (text: string) => string

interface MarkdownState {
  render: MarkdownRenderer | undefined
  /** Bumped on every publish/dispose: `useSyncExternalStore` reads a number. */
  version: number
  listeners: Set<() => void>
}

/** The page global (a literal key: each half bundles its own copy of this module). */
interface MarkdownScope {
  [MARKDOWN_KEY]?: MarkdownState
}

/** The property every half of the page agrees on. */
const MARKDOWN_KEY = '__diorama_markdown__' as const

function state(): MarkdownState {
  const page = globalThis as unknown as MarkdownScope
  page[MARKDOWN_KEY] ??= { render: undefined, version: 0, listeners: new Set() }
  return page[MARKDOWN_KEY]
}

function notify(current: MarkdownState): void {
  current.version += 1
  for (const listener of [...current.listeners]) listener()
}

/**
 * Publish a renderer for every piece of this page. Returns the disposer, which
 * only clears what this publisher put there — another piece may have published
 * since, and its renderer is the live one.
 */
export function publishMarkdown(render: MarkdownRenderer): () => void {
  const current = state()
  current.render = render
  notify(current)
  return () => {
    if (current.render !== render) return
    current.render = undefined
    notify(current)
  }
}

/** The renderer right now (`undefined` before the publisher boots, or after it goes). */
export function markdownRenderer(): MarkdownRenderer | undefined {
  return state().render
}

/** The store surface for `useSyncExternalStore` (a version number, not an object). */
export const markdownStore = {
  subscribe(listener: () => void): () => void {
    const current = state()
    current.listeners.add(listener)
    return () => {
      current.listeners.delete(listener)
    }
  },
  getSnapshot(): number {
    return state().version
  },
}

/**
 * The renderer, as a component reads it: it repaints when a piece publishes
 * one after this component's first render (boot order is the plugin graph's).
 */
export function useMarkdown(): MarkdownRenderer | undefined {
  useSyncExternalStore(markdownStore.subscribe, markdownStore.getSnapshot, markdownStore.getSnapshot)
  return state().render
}
