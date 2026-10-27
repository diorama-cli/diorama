/**
 * The page's `<title>`: the served directory's own name.
 *
 * A browser with several mounts open shows one tab per directory, and a bare
 * `diorama` says nothing about which one it is. The name comes from the mount
 * root — the same path `diorama ls` prints — so it is known before any plugin
 * boots and does not depend on what the boot graph contains.
 *
 * `serveShell` is the only place that holds both the root and the shell file
 * (the shell is static HTML, served before anything fetches `/plugin.json`),
 * which is why the title is written there rather than by the page.
 */
import { basename } from 'node:path'

/** The directory's name; `''` when the root names nothing (a filesystem root). */
export function shellTitle(root: string): string {
  const name = basename(root)
  return name === '/' || name === '\\' ? '' : name
}

/**
 * Replace the shell's own `<title>…</title>` with the directory's name.
 *
 * The name is escaped: a directory may be called `<script>`, and a title is
 * text, not markup. A root that names nothing leaves the shell's title alone.
 */
export function withShellTitle(html: string, root: string): string {
  const title = shellTitle(root)
  if (title === '') return html
  return html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeText(title)}</title>`)
}

/** The handful of characters that end or open markup inside a text node. */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
