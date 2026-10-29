/**
 * code — syntax-highlighted source files (plan.md M1).
 *
 * Claims textual source/config files by extension and renders them with
 * highlight.js. Languages are registered explicitly: the full highlight.js
 * bundle is ~1 MB, and a viewer needs a handful of common ones.
 *
 * Highlighting is done in the browser from the text the kernel pre-read; the
 * markup comes from highlight.js itself (no repository HTML is interpreted).
 *
 * The file is drawn **one row per line** (contract.md §3.11): the gutter of
 * line numbers, the band a reveal leaves behind and a `path:42` jump all need
 * an element per line. `highlightLines` is what makes that safe — each row is a
 * complete HTML fragment, so a span that opens on one line and closes on the
 * next (a block comment, a multi-line string) still colours correctly
 * (docs/m19/spec.md §6).
 *
 * This half also **publishes the engine** on the page (`__diorama_highlight__`,
 * see `diorama-ui`'s `highlight.ts`): the diff readers of `git-changes` colour
 * their rows with the same languages, and a client half cannot import another
 * half (each is its own build). One registration list, two readers.
 */
import type { Context } from 'cordis'
import { useEffect, useMemo, useRef } from 'react'
import { Icon, LineRow, LINE_NUMBERS_ICON, lineNumbersStore, publishHighlighter, provideEntry, setLineNumbers, toggleLineNumbers, useRevealLine, useStore, watchSelection } from 'diorama-ui'
import type {} from 'diorama-plugin-slots'
import type { FileRendererProps } from 'diorama-kernel'
import { CODE_EXTENSIONS, CODE_LANGUAGES, escapeHtml, highlight, highlightLines, languageOf } from './highlight.ts'

export const name = 'code'
export const inject = ['slots']

export { CODE_EXTENSIONS, CODE_LANGUAGES, escapeHtml, highlight, highlightLines, languageOf }

/**
 * Scroll the pane so `line` sits in the middle. The rows are found by their
 * index, so this is one lookup — no per-line measuring, and a range starts at
 * the line the reader asked for.
 */
function useLineFocus(count: number) {
  const list = useRef<HTMLDivElement | null>(null)
  const focus = (line: number): void => {
    const element = list.current
    if (element === null) return
    const target = Math.min(Math.max(1, line), Math.max(1, count))
    element.querySelector<HTMLElement>(`[data-line-number="${target}"]`)?.scrollIntoView({ block: 'center' })
  }
  return { list, focus }
}

/** The renderer's own header (contract.md §3.11): the path, and the gutter switch. */
function Toolbar({ path, shown }: { path: string; shown: boolean }) {
  const label = shown ? '隐藏行号' : '显示行号'
  return (
    <div className="diorama-code__header">
      <span className="diorama-code__path" data-testid="code-path">{path}</span>
      <button
        type="button"
        className={`diorama-code__tool${shown ? ' diorama-code__tool--on' : ''}`}
        data-testid="code-line-numbers"
        aria-pressed={shown}
        title={label}
        aria-label={label}
        onClick={() => setLineNumbers(!shown)}
      >
        <Icon name={LINE_NUMBERS_ICON} size={14} />
      </button>
    </div>
  )
}

function Code({ file, text }: FileRendererProps) {
  // Every line as its own complete HTML fragment (see the module comment).
  const lines = useMemo(() => (text === undefined ? [] : highlightLines(text, file.path)), [text, file.path])
  const language = useMemo(() => languageOf(file.path), [file.path])
  const shown = useStore(lineNumbersStore)
  const { list, focus } = useLineFocus(lines.length)
  // A search hit or a `:42` jump opens the file at its line (§3.9): the reveal
  // store says which, and these rows are what scrolls there.
  const revealed = useRevealLine(file.path, focus, lines.length)

  // One selection, drawn as one block (§3.11): the browser's own highlight is
  // transparent here and these rows carry the boxes instead (see
  // `diorama-ui`'s `selection.ts`).
  useEffect(() => {
    const element = list.current
    if (element === null) return
    return watchSelection(element)
  }, [lines])

  return (
    <div className="diorama-code-wrap" data-testid="code" data-language={language}>
      <Toolbar path={file.path} shown={shown} />
      {text === undefined ? (
        <div className="diorama-renderer__empty" role="status" data-testid="code-binary">
          二进制文件，无法高亮
        </div>
      ) : (
        <div
          className={`diorama-code${shown ? ' diorama-code--numbered' : ''}`}
          data-testid="code-lines"
          data-line-numbers={shown ? 'on' : 'off'}
          ref={list}
        >
          {lines.map((html, index) => (
            <LineRow key={index} line={index + 1} revealed={revealed} revealTestId="code-reveal">
              {/* highlight.js escapes its input; this markup is generated, not copied.
                  An empty line still needs a row with a height: a no-break space. */}
              <span dangerouslySetInnerHTML={{ __html: html === '' ? '\u00a0' : html }} />
            </LineRow>
          ))}
        </div>
      )}
    </div>
  )
}

export function apply(ctx: Context) {
  // The engine every diff reader of this page colours its rows with. Disposing
  // this piece takes it back off the page (another publisher is left alone).
  ctx.effect(
    () => publishHighlighter({ languageOf, lines: highlightLines }),
    'code: publish the highlighter',
  )
  provideEntry(ctx, {
      id: 'code:renderer',
      name: 'file.renderer',
      key: 'code',
      order: 200,
      matcher: { ext: CODE_EXTENSIONS },
  }, Code)

  // The palette's way to the same switch (§3.7): the state is the page-global
  // store, so the command needs no service and works with no file open.
  const commands = clientCommands(ctx)
  if (commands === undefined) return
  commands.register({
    id: 'view.toggleLineNumbers',
    title: '显示 / 隐藏行号',
    run: () => {
      toggleLineNumbers()
    },
  })
}

/** `ctx.commands` when this context is a page (client kernel), else `undefined`. */
function clientCommands(ctx: Context): { register(spec: unknown): unknown } | undefined {
  try {
    return (ctx as unknown as { commands?: { register(spec: unknown): unknown } }).commands
  } catch {
    return undefined
  }
}
