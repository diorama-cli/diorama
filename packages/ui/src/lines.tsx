/**
 * The line-number gutter and the reveal band — the two things every **text**
 * renderer draws the same way (contract.md §3.11, §3.9).
 *
 * `code` and `plaintext` are separate halves (each is its own build), so the
 * shared part lives here in `diorama-ui`: one row shape, one band, one set of
 * class names, styled once in `styles.css`. A renderer supplies the rows (its
 * own markup, escaped or highlighted) and the number is drawn beside them.
 *
 * Rows are what makes the gutter possible at all: a line number needs an
 * element per line, and one `<pre>` of HTML cannot provide one. The same rows
 * are why a revealed range is a band over the rows it covers rather than a
 * measured `top` (docs/m19/spec.md §6: measured positions drift).
 */
import type { ReactElement } from 'react'
import type { RevealedLine } from './reveal.ts'

/** Whether `line` falls inside the revealed range. */
export function inRevealed(revealed: RevealedLine | undefined, line: number): boolean {
  return revealed !== undefined && line >= revealed.line && line <= revealed.endLine
}

/**
 * The band over one revealed line: absolutely positioned inside its row, so a
 * range is a stack of bands that line up without measuring anything.
 *
 * `key` is the request's stamp: asking for the same range again remounts the
 * element, which is what restarts a flash animation (a re-used element would
 * keep the animation it already finished).
 */
export function RevealBand({
  revealed,
  line,
  testId,
}: {
  revealed: RevealedLine | undefined
  line: number
  testId?: string
}): ReactElement | null {
  if (revealed === undefined || !inRevealed(revealed, line)) return null
  return (
    <span
      key={revealed.at}
      className={`diorama-line__reveal${revealed.flash ? ' diorama-line__reveal--flash' : ''}`}
      data-testid={testId}
      data-line={line}
      data-flash={revealed.flash ? 'true' : 'false'}
      aria-hidden="true"
    />
  )
}

/** One row of a text renderer: the gutter cell, the text, and the band. */
export function LineRow({
  line,
  revealed,
  revealTestId,
  children,
}: {
  line: number
  revealed: RevealedLine | undefined
  revealTestId?: string
  children: ReactElement
}): ReactElement {
  return (
    <div className="diorama-line" data-line-number={line}>
      <span className="diorama-line__num" aria-hidden="true">
        {line}
      </span>
      <span className="diorama-line__text">{children}</span>
      <RevealBand revealed={revealed} line={line} testId={revealTestId} />
    </div>
  )
}
