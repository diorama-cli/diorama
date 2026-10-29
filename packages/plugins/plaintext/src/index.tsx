/**
 * plaintext — the fallback renderer.
 *
 * Contract.md §5.1: `plaintext` is the entry **without a matcher**. It is not
 * tried in the `ext` / `mime` / `probe` scan; it renders whatever no other
 * renderer claimed, and takes over when a matched renderer fails. Raw text,
 * monospace, no highlighting and no Markdown.
 *
 * Like `code`, it draws **one row per line** (contract.md §3.11) so the gutter,
 * the reveal band and a `path:42` jump have an element to point at.
 */
import type { Context } from 'cordis'
import { useEffect, useMemo, useRef } from 'react'
import type {} from 'diorama-plugin-slots'
import { Icon, LineRow, LINE_NUMBERS_ICON, lineNumbersStore, provideEntry, setLineNumbers, useRevealLine, useStore, watchSelection } from 'diorama-ui'
import type { FileInfo, FileRendererProps } from 'diorama-kernel'

export const name = 'plaintext'
export const inject = ['slots']

/**
 * How a file with no text is described in the fallback (no mojibake). The
 * kernel pre-reads text only (contract.md §5.1 v0.6), so the size comes from
 * the `stat` the registry already made — the fallback never reads bytes.
 */
function describeBinary(file: FileInfo, mime: string): string {
  return `二进制文件，无法以文本显示（${mime}，${formatSize(file.size)}）`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Split like every reader counts lines: no trailing tail after a final newline. */
function textLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The renderer's own header (contract.md §3.11): the path, and the gutter switch. */
function Toolbar({ path, shown }: { path: string; shown: boolean }) {
  const label = shown ? '隐藏行号' : '显示行号'
  return (
    <div className="diorama-plaintext__header">
      <span className="diorama-plaintext__path" data-testid="plaintext-path">{path}</span>
      <button
        type="button"
        className={`diorama-plaintext__tool${shown ? ' diorama-plaintext__tool--on' : ''}`}
        data-testid="plaintext-line-numbers"
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

function Plaintext({ file, text, mime }: FileRendererProps) {
  const lines = useMemo(() => (text === undefined ? [] : textLines(text)), [text])
  const shown = useStore(lineNumbersStore)
  const list = useRef<HTMLDivElement | null>(null)
  // A search hit or a `:42` jump opens the file at its line (contract.md §3.9).
  const focus = (line: number): void => {
    const element = list.current
    if (element === null) return
    const target = Math.min(Math.max(1, line), Math.max(1, lines.length))
    element.querySelector<HTMLElement>(`[data-line-number="${target}"]`)?.scrollIntoView({ block: 'center' })
  }
  const revealed = useRevealLine(file.path, focus, lines.length)
  // One selection, drawn as one block (§3.11) — see `diorama-ui`'s
  // `selection.ts`; the browser's own highlight is transparent here.
  useEffect(() => {
    const element = list.current
    if (element === null) return
    return watchSelection(element)
  }, [lines])
  return (
    <div className="diorama-plaintext-wrap" data-testid="plaintext">
      <Toolbar path={file.path} shown={shown} />
      {text !== undefined ? (
        <div
          className={`diorama-plaintext${shown ? ' diorama-plaintext--numbered' : ''}`}
          data-path={file.path}
          data-testid="plaintext-lines"
          data-line-numbers={shown ? 'on' : 'off'}
          ref={list}
        >
          {lines.map((line, index) => (
            <LineRow key={index} line={index + 1} revealed={revealed} revealTestId="plaintext-reveal">
              <>{line === '' ? '\u00a0' : line}</>
            </LineRow>
          ))}
        </div>
      ) : (
        <div className="diorama-renderer__empty" role="status" data-testid="plaintext-binary">
          {describeBinary(file, mime)}
        </div>
      )}
    </div>
  )
}

export function apply(ctx: Context) {
  provideEntry(ctx, { id: 'plaintext:fallback', name: 'file.renderer', key: 'plaintext', order: 1_000_000 },
    Plaintext,
  )
}
