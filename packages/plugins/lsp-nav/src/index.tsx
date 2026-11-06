/**
 * `lsp-nav` — go to definition, find references and hover over the code
 * renderer's own rows (contract.md §3.12).
 *
 * The piece draws no file: the rows, the gutter, the line numbers and the
 * reveal band belong to the `code` renderer (§3.11), and a second renderer for
 * `.ts` files would fork them. So this half only says "this page has the
 * gestures"; the gestures themselves live in `diorama-ui` (both halves can see
 * that library, neither can see the other — contract §8), and the renderer
 * wires them when the face is published.
 *
 * A page without this piece draws exactly what it drew before.
 */
import type { Context } from 'cordis'
import { publishLspNav, type LspNav } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'

export const name = 'lsp-nav'
export const inject = ['slots']

/** What this piece offers the renderers of the page. */
export const NAV_FACE: LspNav = { hover: true, references: true }

export function apply(ctx: Context): void {
  const dispose = publishLspNav(NAV_FACE)
  ctx.effect(() => dispose, 'lsp-nav: publish the navigation face')
}
