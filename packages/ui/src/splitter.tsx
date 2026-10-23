/**
 * The draggable edge between two panes (see `splitpane.ts` for the whole
 * story: bounds, the remembered width, and why the drag does not go through
 * React state).
 *
 * This file is `.tsx` and `splitpane.ts` is not, on purpose: `node --test` runs
 * the pure half (bounds, `localStorage`) without a JSX transform. The two
 * basenames differ as well — a `.ts` and a `.tsx` of the same name collide in
 * the declaration bundle.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { clampPane, MAX_PANE_PX, MIN_PANE_PX, PANE_STEP_PX } from './splitpane.ts'

export interface SplitterProps {
  /**
   * Which side of the separator the resized pane is on. `start` = the pane is
   * to the left of the edge (the frame's sidebar, a commit's file list), so
   * dragging right widens it.
   */
  side: 'start' | 'end'
  /** The pane's width right now (px): the separator's accessible value. */
  size: number
  /** Called on every pointer move with the width under the pointer. */
  onPreview(size: number): void
  /** Called once a gesture ends (pointer up, or a key press): remember this. */
  onCommit(size: number): void
  /** Accessible name of the separator (「调整侧栏宽度」). */
  label: string
  min?: number
  max?: number
  testId?: string
}

/**
 * The draggable edge itself. It is a **column of its own** in the caller's
 * grid (5px), so it never overlaps what it separates and never shifts the
 * layout when the pointer touches it.
 */
export function Splitter({
  side,
  size,
  onPreview,
  onCommit,
  label,
  min = MIN_PANE_PX,
  max = MAX_PANE_PX,
  testId,
}: SplitterProps): ReactElement {
  const drag = useRef<{ pointerId: number; x: number; size: number } | undefined>(undefined)
  const [dragging, setDragging] = useState(false)
  // Which way the pointer moves the edge: the pane to the left of the edge
  // grows with the pointer, one to its right grows against it.
  const direction = side === 'start' ? 1 : -1

  const stop = (): void => {
    drag.current = undefined
    setDragging(false)
    globalThis.document?.body.classList.remove('diorama-resizing')
  }

  const widthAt = (event: ReactPointerEvent<HTMLDivElement>, state: { x: number; size: number }): number =>
    clampPane(state.size + (event.clientX - state.x) * direction, min, max)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, x: event.clientX, size }
    setDragging(true)
    // The cursor stays `col-resize` and nothing gets selected while the pointer
    // travels over the content it is resizing.
    globalThis.document?.body.classList.add('diorama-resizing')
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === undefined || state.pointerId !== event.pointerId) return
    onPreview(widthAt(event, state))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === undefined || state.pointerId !== event.pointerId) return
    const next = widthAt(event, state)
    stop()
    onCommit(next)
  }

  // The keyboard path: the separator is focusable, so a pane's width is not a
  // mouse-only setting. Shift moves by four steps.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? PANE_STEP_PX * 4 : PANE_STEP_PX
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = size - direction * step
    else if (event.key === 'ArrowRight') next = size + direction * step
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    if (next === undefined) return
    event.preventDefault()
    const clamped = clampPane(next, min, max)
    onPreview(clamped)
    onCommit(clamped)
  }

  return (
    <div
      className="diorama-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-side={side}
      data-dragging={dragging ? 'true' : undefined}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={onKeyDown}
    />
  )
}
