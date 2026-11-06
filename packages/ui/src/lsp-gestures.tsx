/**
 * The three gestures a **navigation piece** adds to a text renderer
 * (contract.md §3.12).
 *
 * Why this lives in `diorama-ui` and not in the piece: the gesture needs the
 * renderer's rows (the caret's line and column), and a renderer half cannot
 * import another half — each is its own build (contract §8). The shared
 * library is the one place both can see. The piece's only job is to publish a
 * face saying "these gestures are on this page" (`lsp-nav.ts`); a build
 * without it wires nothing and draws exactly what it drew before.
 *
 * Nothing here writes. Every request goes through `mountCtx.lsp`, which is
 * read-only by construction (§3.12), and every failure is silence: a jump that
 * cannot be answered is a click that does nothing, never a banner.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ContextMenu, type MenuItem } from './contextmenu.tsx'
import { reveal } from './reveal.ts'
import { chooseTargets, describePlace, isSelf, type DefinitionPlace, type LabelledPlace } from './definition-list.ts'
import { hoverBlock, hoverIsEmpty } from './hover-card.ts'
import { useLspNav } from './lsp-nav.ts'
import { useHeldModifier } from './keys.tsx'
import { TEXT_ROWS, wordAt, wordTextAt, type RowGeometry, type TextPosition } from './lsp-position.ts'
import { useMarkdown } from './markdown.ts'
import { useHighlighter } from './highlight.ts'

export { TEXT_ROWS, wordAt, type RowGeometry, type TextPosition } from './lsp-position.ts'

/**
 * How long the pointer must rest on a symbol before the hover card asks.
 *
 * A second, not a few hundred milliseconds: the card is a **reading** aid, and
 * a card that appears while the pointer is crossing a line is noise — it pops
 * up under the cursor, covers the code below it, and has to be dismissed. One
 * second is long enough to mean "I stopped here".
 */
export const HOVER_DELAY_MS = 1000

/**
 * How long the card stays after the pointer leaves the word.
 *
 * **Zero.** Leaving is a decision, not a pause: the reader moved off because
 * they were done with it, and a card that lingers over the code they are now
 * reading is in the way. (The grace period existed to survive the one-frame
 * gap between two adjacent spans of the same word; the pointer handler keeps
 * the card up while it is still over the same identifier, so nothing is lost.)
 */
export const HOVER_GRACE_MS = 0

/** A place the page can open. */
export interface NavTarget {
  path: string
  line: number
  character: number
}

/** The slice of `mountCtx.lsp` these gestures use (contract.md §3.12). */
export interface LspFace {
  definition(path: string, position: TextPosition, text?: string): Promise<NavLocation[]>
  references(path: string, position: TextPosition, text?: string): Promise<NavLocation[]>
  hover(path: string, position: TextPosition, text?: string): Promise<{ contents: string } | undefined>
}

/** One place in the mount (the kernel's `LspLocation`, structurally). */
export interface NavLocation {
  path: string
  range: { start: TextPosition; end: TextPosition }
}

/** One place an answer named, in the shape the chooser wants. */
function placeOf(location: NavLocation): DefinitionPlace {
  return {
    path: location.path,
    line: location.range.start.line,
    character: location.range.start.character,
    endLine: location.range.end.line,
  }
}

/** The slice of `ctx.tabs` a jump needs (contract.md §3.4). */
export interface TabsFace {
  open(file: { path: string; name: string; kind: 'file'; size: number; mtime: number }): unknown
}

/** What the renderer tells the gestures about the file it drew. */
export interface GestureOptions {
  /**
   * The page kernel, as `useKernel()` returns it: `ctx` carries the services
   * (`tabs`) and `mount` is this mount's handle (`fs`, `git`, `lsp` …).
   */
  ctx: { ctx?: { tabs?: TabsFace }; tabs?: TabsFace; mount?: { lsp?: LspFace } }
  /** The file's mount-relative path. */
  path: string
  /**
   * The text the renderer is drawing. The server is told about **this**, not
   * the file on disk: a diff view draws a file it does not have, and a jump
   * computed from other bytes lands on the wrong line (docs/m33/spec.md §6).
   */
  text?: string
  /** The element whose rows carry the line attribute. */
  host: { readonly current: HTMLElement | null }
  /**
   * How this renderer marks its rows. The default is the text renderers'
   * (`data-line-number` + `.diorama-line__text`); a diff reader passes its own,
   * because its rows are the diff model and its code cell carries a `+` / `-`
   * prefix in the inline mode (contract.md §3.12, §5.2).
   */
  rows?: RowGeometry
}


/** What the renderer draws besides its rows. */
export interface GestureSurface {
  handlers: {
    onClick(event: React.MouseEvent): void
    onContextMenu(event: React.MouseEvent): void
    onMouseOver(event: React.MouseEvent): void
    onMouseMove(event: React.MouseEvent): void
    onMouseLeave(event: React.MouseEvent): void
  }
  /** The context menu and the hover card, to render beside the rows. */
  overlay: ReactElement | null
}

/**
 * The row and column a DOM point belongs to, in the page's own units.
 *
 * A row with no line attribute is **not** addressable in the current file —
 * a deleted line in a diff, the old column of the side-by-side reader — and
 * answers `undefined` rather than a number that would point at a different
 * line of the file the server knows about.
 */
export function positionAt(node: Node | null, offset: number, rows: RowGeometry = TEXT_ROWS): TextPosition | undefined {
  if (node === null) return undefined
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const row = element?.closest('[' + rows.lineAttribute + ']')
  if (row === null || row === undefined) return undefined
  const raw = row.getAttribute(rows.lineAttribute)
  const line = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(line) || line < 1) return undefined
  const cell = row.querySelector(rows.cellSelector)
  if (cell === null) return undefined
  if (cell !== node && !cell.contains(node)) return undefined
  const range = document.createRange()
  range.setStart(cell, 0)
  try {
    range.setEnd(node, offset)
  } catch {
    return undefined
  }
  return { line, character: Math.max(0, range.toString().length - (rows.trim ?? 0)) }
}

/** The caret a pointer event landed on (standard first, WebKit second). */
export function caretOf(event: { clientX: number; clientY: number }): { node: Node; offset: number } | undefined {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const standard = doc.caretPositionFromPoint?.(event.clientX, event.clientY)
  if (standard !== undefined && standard !== null) return { node: standard.offsetNode, offset: standard.offset }
  const legacy = doc.caretRangeFromPoint?.(event.clientX, event.clientY)
  if (legacy !== undefined && legacy !== null) return { node: legacy.startContainer, offset: legacy.startOffset }
  return undefined
}

/** Open a file at a line, then flash it (contract.md §3.4, §3.9). */
export function jump(ctx: { tabs?: TabsFace }, target: NavTarget): void {
  const name = target.path.split('/').pop() ?? target.path
  ctx.tabs?.open({ path: target.path, name, kind: 'file', size: 0, mtime: 0 })
  reveal(target.path, target.line, { flash: true })
}

/**
 * The hover card (contract.md §3.12).
 *
 * The answer is Markdown, so it is **rendered**, not printed: a fenced block
 * becomes a coloured `<pre><code>`, a doc comment becomes a paragraph. Two
 * page globals make that possible without this module importing another half
 * (§8): the Markdown renderer (published by the `markdown` piece) and the
 * syntax engine (published by `code`).
 *
 * Every fallback is honest: no renderer → the answer as plain text; a single
 * fence → the fence's code, coloured; an empty answer → no card at all.
 */
function HoverCard({ contents, top, left }: { contents: string; top: number; left: number }): ReactElement | null {
  const render = useMarkdown()
  const engine = useHighlighter()
  const html = useMemo(() => (render === undefined ? undefined : render(contents)), [render, contents])
  const block = useMemo(() => hoverBlock(contents), [contents])
  const code = useMemo(() => {
    if (block === undefined) return undefined
    return engine?.block?.(block.code, block.language) ?? undefined
  }, [block, engine])

  if (hoverIsEmpty(contents)) return null
  return (
    <div className="diorama-hover" data-testid="lsp-hover" style={{ top, left }} role="tooltip">
      {block !== undefined && html === undefined ? (
        // No Markdown renderer on this page: the answer is one fence, so draw
        // its code (coloured when there is an engine, escaped otherwise).
        <pre className="diorama-hover__code">
          {code === undefined ? <code>{block.code}</code> : <code dangerouslySetInnerHTML={{ __html: code.html }} />}
        </pre>
      ) : html === undefined ? (
        <div className="diorama-hover__prose">{contents}</div>
      ) : (
        // Sanitised inside the publisher (DOMPurify, the same call that draws a
        // `.md` file): escaping it again would show `&lt;` instead of `<`.
        <div className="diorama-hover__doc diorama-markdown" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}

/**
 * The underline under the identifier a ⌘/Ctrl+click would act on
 * (contract.md §3.12).
 *
 * It is a **band measured from the DOM**, not a CSS class on the row: a row is
 * a whole line, and underlining the line would say "the whole line is a link".
 * The geometry comes from a `Range` over the word's own text nodes, which is
 * the same measurement the caret uses — so the band sits under exactly the
 * characters the click would ask about.
 *
 * It is `position: fixed` at viewport coordinates and `pointer-events: none`:
 * it must not take the pointer away from the word it describes, and it must
 * not be clipped by the scrolling pane it was drawn in.
 */
function LinkUnderline({ word }: { word: { element: HTMLElement; text: string } }): ReactElement | null {
  const box = useMemo(() => underlineBox(word), [word])
  if (box === undefined) return null
  return (
    <span
      className="diorama-link-underline"
      data-testid="lsp-link"
      aria-hidden="true"
      style={{ left: box.left, top: box.top, width: box.width }}
    />
  )
}

/** Where the band goes: the union of the word's own text rectangles. */
function underlineBox(word: { element: HTMLElement; text: string }): { left: number; top: number; width: number } | undefined {
  const { element, text } = word
  if (text === '') return undefined
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const content = node.textContent ?? ''
    const at = content.indexOf(text)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + text.length)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0) continue
    return { left: rect.left, top: rect.bottom - 1, width: rect.width }
  }
  return undefined
}

/** The identifier under a viewport point, as the underline needs it. */
function linkWordAt(
  x: number,
  y: number,
  text: string,
  rows: RowGeometry,
): { element: HTMLElement; text: string } | undefined {
  const caret = caretOf({ clientX: x, clientY: y })
  if (caret === undefined) return undefined
  const position = positionAt(caret.node, caret.offset, rows)
  if (position === undefined) return undefined
  const word = wordAt(text, position)
  if (word === undefined) return undefined
  const label = wordTextAt(text, word)
  if (label === '') return undefined
  const element = document.elementFromPoint(x, y)
  if (element === null) return undefined
  return { element: element as HTMLElement, text: label }
}

/**
 * Wire the gestures onto a renderer's rows. Returns `undefined` when this page
 * has no navigation piece — the renderer then draws exactly what it drew
 * before, and no listener is attached.
 */
export function useLspGestures(options: GestureOptions): GestureSurface | undefined {
  const face = useLspNav()
  const { ctx, path, text, host } = options
  const rows = options.rows ?? TEXT_ROWS
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | undefined>(undefined)
  const [hover, setHover] = useState<{ contents: string; top: number; left: number } | undefined>(undefined)
  // Several definitions → a list to pick from (contract.md §3.12).
  const [choices, setChoices] = useState<{ x: number; y: number; targets: readonly LabelledPlace[] } | undefined>(
    undefined,
  )
  /**
   * The identifier under the pointer while a modifier is held (contract.md
   * §3.12). It is a DOM element so the underline follows the *word*, not the
   * row: a row is a whole line of text and underlining it would say "the whole
   * line is a link".
   */
  const [linkWord, setLinkWord] = useState<{ element: HTMLElement; text: string } | undefined>(undefined)
  /** The element whose cursor we changed, and what it was before. */
  const cursorHost = useRef<{ element: HTMLElement; previous: string } | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /**
   * Where the pointer last was, in viewport coordinates.
   *
   * Pressing ⌘ / Ctrl fires **no pointer event**, so "what is under the
   * pointer right now" cannot be answered from an event when the modifier
   * changes — it has to be answered from where the pointer already is
   * (contract.md §3.12). `elementFromPoint` then names the element.
   */
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined)

  const lsp = ctx.mount?.lsp
  const tabs = ctx.ctx?.tabs ?? ctx.tabs
  const held = useHeldModifier()

  const clearTimers = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  // Releasing ⌘ / Ctrl fires no mouse event, so the underline has to be taken
  // down here: the pointer never moves, and a band left behind would claim a
  // click that no longer does anything (contract.md §3.12).
  //
  // Holding one takes the **hover card** down for the same reason, in the
  // other direction: the card sits at the pointer, and the list a click opens
  // sits at the pointer too — a card left up covers the rows the reader is
  // trying to pick (docs/m33/spec.md §6).
  useEffect(() => {
    if (held === undefined) {
      setLinkWord(undefined)
      return
    }
    clearTimers()
    setHover(undefined)
    // The modifier went down **without the pointer moving**, so no `mouseover`
    // will arrive to set the underline. Ask where the pointer already is.
    const at = pointer.current
    if (at === undefined) return
    setLinkWord(linkWordAt(at.x, at.y, text ?? '', rows))
  }, [clearTimers, held, rows, text])

  /**
   * A link says so with the pointer (contract.md §3.12).
   *
   * The hand cursor goes on the **token**, not on the pane: the renderer's
   * rows are plain text, and a pane-wide `cursor: pointer` would promise a
   * click over whitespace too. So the element the pointer is over is given the
   * cursor directly, and its previous inline value is put back the moment the
   * pointer moves off — an element that keeps `pointer` after the modifier is
   * released is a lie the reader cannot see through.
   */
  useEffect(() => {
    const current = cursorHost.current
    const element = linkWord?.element
    if (current !== undefined && current.element !== element) {
      current.element.style.cursor = current.previous
      cursorHost.current = undefined
    }
    if (element === undefined) return
    if (cursorHost.current?.element === element) return
    cursorHost.current = { element, previous: element.style.cursor }
    element.style.cursor = 'pointer'
  }, [linkWord])

  // The page can unmount while the pointer is still over a token.
  useEffect(
    () => () => {
      const current = cursorHost.current
      if (current === undefined) return
      current.element.style.cursor = current.previous
      cursorHost.current = undefined
    },
    [],
  )

  /**
   * Go to definition: **one place jumps, several are listed** (contract.md
   * §3.12). Jumping to the first of several is a silent guess — the reader
   * lands somewhere plausible and never learns the others were there.
   */
  /**
   * Go to definition **or usage** (contract.md §3.12).
   *
   * Both answers are asked for and merged, then the place the reader clicked
   * is dropped (`chooseTargets`). That one step is what makes the gesture
   * work in both directions: on a usage the declaration is left, on a
   * declaration the usages are left. Without it a declaration click answers
   * "you are already here" and highlights itself.
   *
   * The two calls go out together: they are independent, and the reader is
   * waiting on a click.
   */
  const definitionAt = useCallback(
    (position: TextPosition, at: { x: number; y: number }): void => {
      if (lsp === undefined) return
      const anchor = wordAt(text ?? '', position) ?? position
      void Promise.all([
        lsp.definition(path, anchor, text).catch(() => [] as NavLocation[]),
        lsp.references(path, anchor, text).catch(() => [] as NavLocation[]),
      ])
        .then(([definitions, references]) => {
          const choice = chooseTargets(definitions.map(placeOf), references.map(placeOf), {
            path,
            line: position.line,
            character: position.character,
          })
          if (choice.kind === 'none') return
          if (choice.kind === 'jump') {
            jump({ tabs }, { path: choice.target.path, line: choice.target.line, character: choice.target.character })
            return
          }
          setChoices({ x: at.x, y: at.y, targets: choice.targets })
        })
        .catch(() => undefined)
    },
    [lsp, path, tabs, text],
  )

  const handlers = useMemo(
    () => ({
      onClick(event: React.MouseEvent): void {
        if (!(event.metaKey || event.ctrlKey)) return
        const caret = caretOf(event)
        if (caret === undefined) return
        const position = positionAt(caret.node, caret.offset, rows)
        if (position === undefined) return
        event.preventDefault()
        definitionAt(position, { x: event.clientX, y: event.clientY })
      },
      onContextMenu(event: React.MouseEvent): void {
        if (face?.references !== true || lsp === undefined) return
        const caret = caretOf(event)
        if (caret === undefined) return
        const position = positionAt(caret.node, caret.offset, rows)
        if (position === undefined) return
        event.preventDefault()
        const anchor = wordAt(text ?? '', position) ?? position
        const menuX = event.clientX
        const menuY = event.clientY
        setMenu({
          x: menuX,
          y: menuY,
          items: [
            {
              id: 'lsp.definition',
              label: '转到定义',
              run: () => {
                definitionAt(anchor, { x: menuX, y: menuY })
              },
            },
            {
              id: 'lsp.references',
              label: '查找使用处',
              run: () => {
                void lsp
                  .references(path, anchor, text)
                  .then((locations: NavLocation[]) => {
                    const targets: LabelledPlace[] = locations
                      .map(placeOf)
                      .filter(place => !isSelf(place, { path, line: position.line, character: position.character }))
                      .map(place => ({ ...place, kind: 'usage' as const }))
                    if (targets.length === 0) return
                    if (targets.length === 1) {
                      const only = targets[0] as LabelledPlace
                      jump({ tabs }, { path: only.path, line: only.line, character: only.character })
                      return
                    }
                    setChoices({ x: menuX, y: menuY, targets })
                  })
                  .catch(() => undefined)
              },
            },
          ],
        })
      },
      onMouseMove(event: React.MouseEvent): void {
        pointer.current = { x: event.clientX, y: event.clientY }
      },
      onMouseOver(event: React.MouseEvent): void {
        if (face === undefined || lsp === undefined) return
        pointer.current = { x: event.clientX, y: event.clientY }
        // The underline is its own cue: it says "this word is a link" before
        // the reader clicks (contract.md §3.12).
        const caret = caretOf(event)
        const position = caret === undefined ? undefined : positionAt(caret.node, caret.offset, rows)
        const anchor = position === undefined ? undefined : wordAt(text ?? '', position)
        if (held !== undefined && anchor !== undefined) {
          setLinkWord({ element: event.target as HTMLElement, text: wordTextAt(text ?? '', anchor) })
        } else if (linkWord !== undefined) {
          setLinkWord(undefined)
        }
        // While a modifier is held the pointer is aiming at a click, not asking
        // for a tooltip: the card would sit on top of the list the click opens.
        // Off a token — whitespace, punctuation, another row's gutter — is
        // leaving: the card goes at once, not when the pointer leaves the pane
        // (contract.md §3.12).
        if (anchor === undefined) {
          clearTimers()
          setHover(undefined)
          return
        }
        if (held !== undefined) return
        if (face.hover !== true) return
        clearTimers()
        const x = event.clientX
        const y = event.clientY
        timer.current = setTimeout(() => {
          void lsp
            .hover(path, anchor, text)
            .then(result => {
              if (result === undefined) return
              const box = host.current?.getBoundingClientRect()
              const left = box === undefined ? x : Math.min(x, box.right - 340)
              setHover({ contents: result.contents, top: y + 18, left })
            })
            .catch(() => undefined)
        }, HOVER_DELAY_MS)
      },
      onMouseLeave(): void {
        setLinkWord(undefined)
        clearTimers()
        // Straight down: no grace timer, no lingering card (see HOVER_GRACE_MS).
        setHover(undefined)
      },
    }),
    [clearTimers, definitionAt, face, held, host, linkWord, lsp, path, rows, tabs, text],
  )

  if (face === undefined) return undefined

  const overlay = (
    <>
      {menu === undefined ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={path}
          items={menu.items}
          onClose={() => {
            setMenu(undefined)
          }}
        />
      )}
      {choices === undefined ? null : (
        <ContextMenu
          x={choices.x}
          y={choices.y}
          title={path}
          items={choices.targets.map((target, index) => ({
            id: 'lsp.definition:' + index,
            label: describePlace(target),
            run: () => {
              jump({ tabs }, { path: target.path, line: target.line, character: target.character })
            },
          }))}
          onClose={() => {
            setChoices(undefined)
          }}
        />
      )}
      {linkWord === undefined ? null : <LinkUnderline word={linkWord} />}
      {hover === undefined ? null : <HoverCard contents={hover.contents} top={hover.top} left={hover.left} />}
    </>
  )

  return { handlers, overlay }
}
