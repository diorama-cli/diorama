/**
 * A document's outline: the headings of the Markdown file on screen.
 *
 * The renderer already numbers every heading while it parses (a `#fragment`
 * link needs the same `id`), so the outline is not a second parse — the same
 * list is what the document draws beside itself. It belongs to **this**
 * document, so it lives in the renderer and in its own tab: one file's headings
 * are not a view of the left column (contract.md §5.1).
 *
 * The pure helpers are here (not in the component file) because `node --test`
 * cannot load `.tsx` (AGENTS §5).
 */

/** One heading, as the outline shows it. */
export interface OutlineEntry {
  /** `1` for `<h1>` … `6` for `<h6>`. */
  depth: number
  /** The heading's `id`, which is where a click scrolls to. */
  id: string
  /** The heading's text, markup removed. */
  text: string
}

/**
 * A heading's rendered inline HTML as plain text: tags dropped, the entities
 * marked emits turned back into characters, whitespace collapsed. This is what
 * the outline lists — `Hello <em>World</em>` reads "Hello World", not the markup.
 */
export function plainHeadingText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_match, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The outline as a reader sees it: the shallowest level is the root, and no
 * level is skipped by more than one step.
 *
 * A document that starts at `##` (a chapter of a larger book) should not be
 * indented under nothing, and an `h2` followed by `h4` should not leave a gap
 * that looks like a missing entry. Both are normalisations of the same list.
 */
export function normalizeOutline(entries: readonly OutlineEntry[]): OutlineEntry[] {
  if (entries.length === 0) return []
  const base = Math.min(...entries.map(entry => entry.depth))
  const out: OutlineEntry[] = []
  let previous = 0
  for (const entry of entries) {
    const depth = Math.min(entry.depth - base + 1, previous + 1)
    out.push({ ...entry, depth })
    previous = depth
  }
  return out
}

/**
 * How many headings a document needs before the outline is worth drawing.
 *
 * One heading is the title a reader can already see; a rail beside it would
 * only repeat the page and take width from the text. Two is where "where am I"
 * starts to have an answer.
 */
export const OUTLINE_MIN_HEADINGS = 2
