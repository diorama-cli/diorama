/**
 * A context menu (contract.md §5.2, §36).
 *
 * A **view's own control**, like its toolbar (§35): the view knows what can be
 * done to one of its rows, so the menu is drawn inside that view's component
 * rather than registered into a seat. The primitive here is only the panel —
 * where it sits, how it closes, how the keyboard walks it — because those rules
 * are the same everywhere and a second copy in the next piece would drift.
 *
 * Position is `fixed`, at the pointer. The page's containers carry no
 * `transform` / `filter` / `contain` (see the stylesheet), so `fixed` is
 * relative to the viewport and the menu is **not** clipped by the scrolling
 * pane it was opened in — which is why no portal is needed and the page's module
 * table stays at two entries (contract.md §8).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'

/** One line of a menu. */
export interface MenuItem {
  /** Stable id: the test hook (`data-menu-item`) and the React key. */
  id: string
  /** What the reader reads. */
  label: string
  run(): void
  /** Greyed out and skipped by the keyboard, but still listed. */
  disabled?: boolean
  /** A short explanation under the label (why it is disabled, what it copies). */
  hint?: string
}

export interface ContextMenuProps {
  /** Where the pointer was, in viewport coordinates. */
  x: number
  y: number
  /** What the menu is about, shown at its top (`src/app.js`). */
  title?: string
  items: readonly MenuItem[]
  onClose(): void
}

/** Gap between the pointer and the panel's corner. */
const OFFSET = 2

/**
 * The panel. Closes on Escape, on a press outside, on scroll and on resize —
 * a menu anchored to a point of the page is wrong the moment that point moves.
 */
export function ContextMenu({ x, y, title, items, onClose }: ContextMenuProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x + OFFSET, top: y + OFFSET })
  const enabled = items.map((item, index) => (item.disabled === true ? -1 : index)).filter(index => index !== -1)
  const [cursor, setCursor] = useState(enabled[0] ?? 0)

  // Flip and clamp once the panel has a size: a right-click near the edge must
  // not push the menu off the page. `useLayoutEffect` so the correction happens
  // before the first paint (no visible jump).
  useLayoutEffect(() => {
    const box = ref.current
    if (box === null) return
    const { width, height } = box.getBoundingClientRect()
    const left = x + OFFSET + width > window.innerWidth ? Math.max(OFFSET, x - width - OFFSET) : x + OFFSET
    const top = y + OFFSET + height > window.innerHeight ? Math.max(OFFSET, y - height - OFFSET) : y + OFFSET
    setPosition({ left, top })
  }, [x, y])

  // Focus lands on the first item so the arrow keys work without a Tab.
  useEffect(() => {
    const box = ref.current
    const first = box?.querySelector<HTMLElement>('[data-menu-item]:not([aria-disabled="true"])')
    first?.focus()
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node) === true) return
      onClose()
    }
    // `true`: the pane under the menu scrolls too, and a scroll inside the menu
    // itself would also move the anchor.
    const onScroll = (): void => onClose()
    const onResize = (): void => onClose()
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose])

  const move = (delta: number): void => {
    if (enabled.length === 0) return
    const at = enabled.indexOf(cursor)
    const next = at === -1 ? enabled[0] : enabled[(at + delta + enabled.length) % enabled.length]
    setCursor(next ?? 0)
  }

  const choose = (item: MenuItem | undefined): void => {
    if (item === undefined || item.disabled === true) return
    item.run()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="diorama-menu"
      role="menu"
      aria-label={title === undefined ? '文件操作' : `${title} 的操作`}
      data-testid="context-menu"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          if (enabled.length > 0) setCursor(enabled[0] ?? 0)
        } else if (event.key === 'End') {
          event.preventDefault()
          if (enabled.length > 0) setCursor(enabled[enabled.length - 1] ?? 0)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          choose(items[cursor])
        } else if (event.key === 'Tab') {
          // A menu is not part of the tab order: Tab leaves it (contract §5.2).
          event.preventDefault()
          onClose()
        }
      }}
    >
      {title !== undefined && (
        <div className="diorama-menu__title" title={title}>
          {title}
        </div>
      )}
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`diorama-menu__item${index === cursor ? ' diorama-menu__item--active' : ''}`}
          data-menu-item={item.id}
          aria-disabled={item.disabled === true ? true : undefined}
          disabled={item.disabled === true}
          onMouseEnter={() => {
            if (item.disabled !== true) setCursor(index)
          }}
          onClick={() => choose(item)}
        >
          <span className="diorama-menu__label">{item.label}</span>
          {item.hint !== undefined && <span className="diorama-menu__hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
}
