/**
 * palette — the command palette (contract.md §3.7, §5).
 *
 * A piece, not the kernel: it registers one entry in `layout.overlay` and lists
 * `ctx.commands`. The registry is the kernel's; this piece only draws it,
 * filters it and runs what the user picks. The palette is reachable with
 * `mod+k` through the same binding table a shortcut uses — there is no second
 * dispatch path.
 *
 * Only commands that are executable *now* are listed (contract.md §3.7): the
 * palette never shows a row that would do nothing.
 *
 * A query that starts with `:` is not a command search — it is **go to line**
 * (§3.11): `:42`, `:42-60`. The palette is where a reader already looks for
 * "somewhere I can type at", so the line jump lives here rather than in a second
 * input; `:` itself is a shortcut that opens this palette with the colon typed.
 *
 * Whether it is open is page state shared with the other overlays (v0.7): the
 * seat is a list, so the palette and the shortcut sheet take turns. That state
 * lives on the page global (`overlayStore` in `diorama-ui`), not in a module
 * object — a client half is one script per page, but a test harness may boot
 * several pages in one browser context, and the other overlays are other builds.
 */
import type { Context } from 'cordis'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CommandsService, TabsService } from 'diorama-kernel/client'
import { formatLineSpec, hideOverlay, overlayPayload, overlayStore, parseLineSpec, provideEntry, reveal, showOverlay, toggleOverlay, useKernel, useStore, type LineTarget } from 'diorama-ui'

export const name = 'palette'
export const inject = ['slots']

/** This overlay's id in the page's overlay store (see `diorama-ui/overlay`). */
export const OVERLAY_ID = 'palette'

/** Case-insensitive subsequence match, so "cltab" finds "tabs.close". */
function fuzzy(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  let index = 0
  for (const char of query.toLowerCase()) {
    index = haystack.indexOf(char, index)
    if (index === -1) return false
    index++
  }
  return true
}

/** Whether this overlay is the one that is up (a primitive snapshot). */
function useOpen(): boolean {
  return useSyncExternalStore(overlayStore.subscribe, overlayStore.getSnapshot, overlayStore.getSnapshot) === OVERLAY_ID
}

function setOpen(open: boolean): void {
  if (open) showOverlay(OVERLAY_ID)
  else hideOverlay(OVERLAY_ID)
}

function Palette() {
  const kernel = useKernel()
  const commands = kernel.ctx.commands as unknown as CommandsService
  const snapshot = useSyncExternalStore(commands.subscribe, commands.getSnapshot, commands.getSnapshot)
  const tabs = tabsOf(kernel.ctx)
  const activePath = useActivePath(tabs)
  const open = useOpen()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)

  // Reset the query each time it opens, and focus its field. The opener may
  // hand one in — `:` opens the palette with the colon already typed (§3.11).
  useEffect(() => {
    if (!open) return
    setQuery(overlayPayload(OVERLAY_ID) ?? '')
    setSelected(0)
    const timer = setTimeout(() => input.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  if (!open) return null

  // `:` is go-to-line, not a command search (§3.11): the text after the colon
  // is a line or a range, and the list becomes the one thing Enter can do.
  const lineQuery = query.startsWith(':') ? parseLineSpec(query.slice(1)) : undefined
  const goToLine = query.startsWith(':')
  const lineTarget: LineTarget | undefined = goToLine ? lineQuery : undefined
  const canJump = lineTarget !== undefined && activePath !== undefined

  const rows = goToLine
    ? []
    : snapshot.commands
      .filter(command => commands.canRun(command.id))
      .filter(command => query === '' || fuzzy(command.title, query) || fuzzy(command.id, query))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  const active = Math.min(selected, Math.max(rows.length - 1, 0))

  /**
   * The keys that run a command, as text (contract.md §3.7, v0.17). Read off the
   * registry snapshot — the same `label` the on-screen chips and the shortcut
   * sheet print, so the three surfaces can never spell one binding differently.
   * A command bound to several keys lists them all: the palette is where a
   * reader looks one up, and hiding the second key would send them to `?`.
   */
  const keysFor = (id: string): string[] => {
    const labels: string[] = []
    for (const binding of snapshot.bindings) {
      if (binding.command !== id || labels.includes(binding.label)) continue
      labels.push(binding.label)
    }
    return labels
  }

  const run = (id: string): void => {
    setOpen(false)
    void commands.run(id)
  }

  /**
   * Go to line (§3.11): the line travels through the reveal store, which the
   * text renderer follows (a tab carries a path only, §3.4). A line past the
   * end lands on the last one — see `clampTarget`.
   */
  const jump = (target: LineTarget): void => {
    if (activePath === undefined) return
    setOpen(false)
    reveal(activePath, target.start, { endLine: target.end, flash: true })
  }

  const move = (delta: number): void => {
    if (rows.length === 0) return
    setSelected((active + delta + rows.length) % rows.length)
  }

  return (
    <div className="diorama-palette" data-testid="palette" role="dialog" aria-label="命令面板" data-command-keys>
      <div className="diorama-palette__backdrop" onClick={() => setOpen(false)} />
      <div className="diorama-palette__panel">
        <input
          ref={input}
          className="diorama-palette__input"
          data-testid="palette-input"
          placeholder="输入命令…"
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={event => {
            // The palette owns the keys while its field has focus: the kernel's
            // dispatcher already ignores text entry (contract.md §3.7).
            if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (goToLine) {
                if (lineTarget !== undefined) jump(lineTarget)
                return
              }
              const target = rows[active]
              if (target !== undefined) run(target.id)
            }
          }}
        />
        {goToLine ? (
          <ul className="diorama-palette__list" role="listbox">
            {canJump ? (
              <li
                role="option"
                aria-selected
                className="diorama-palette__item diorama-palette__item--active"
                data-testid="palette-goto-line"
                data-line={formatLineSpec(lineTarget as LineTarget)}
                onClick={() => jump(lineTarget as LineTarget)}
              >
                <span className="diorama-palette__title">跳转到第 {formatLineSpec(lineTarget as LineTarget)} 行</span>
                <span className="diorama-palette__id">{activePath}</span>
              </li>
            ) : (
              <li className="diorama-palette__empty" data-testid="palette-goto-line-empty">
                {lineTarget === undefined ? '输入行号，例如 :42 或 :42-60' : '没有打开的文件，无法跳转'}
              </li>
            )}
          </ul>
        ) : (
        <ul className="diorama-palette__list" role="listbox">
          {rows.map((command, index) => {
            const keys = keysFor(command.id)
            return (
              <li
                key={command.id}
                role="option"
                aria-selected={index === active}
                className={`diorama-palette__item${index === active ? ' diorama-palette__item--active' : ''}`}
                data-command={command.id}
                onMouseEnter={() => setSelected(index)}
                onClick={() => run(command.id)}
              >
                <span className="diorama-palette__title">{command.title}</span>
                {/* A row with a shortcut says so, on the same line, right-aligned
                    (contract.md §3.7, v0.17): a command a reader can also reach
                    with a key should teach them that key. No key → nothing, not
                    an empty slot. */}
                {keys.length > 0 && (
                  <span className="diorama-palette__keys" data-testid="palette-keys">
                    {keys.map(label => (
                      <kbd key={label} className="diorama-palette__key">
                        {label}
                      </kbd>
                    ))}
                  </span>
                )}
                <span className="diorama-palette__id">{command.id}</span>
              </li>
            )
          })}
          {rows.length === 0 && (
            <li className="diorama-palette__empty" data-testid="palette-empty">
              没有可执行的命令
            </li>
          )}
        </ul>
        )}
      </div>
    </div>
  )
}

/** `ctx.tabs` when this page has one (the palette works without it). */
function tabsOf(ctx: Context): TabsService | undefined {
  try {
    return (ctx as unknown as { tabs?: TabsService }).tabs
  } catch {
    return undefined
  }
}

/** The path of the active tab: what `:42` jumps inside (§3.11). */
function useActivePath(tabs: TabsService | undefined): string | undefined {
  const snapshot = tabs === undefined ? undefined : useStore(tabs)
  if (snapshot === undefined) return undefined
  return snapshot.tabs.find(tab => tab.id === snapshot.activeId)?.path
}

export function apply(ctx: Context) {
  // A client-only kernel service: absent in the server tree, where this piece
  // contributes nothing (and must not fail to activate).
  const commands = clientCommands(ctx)
  if (commands === undefined) return
  provideEntry(ctx, { id: 'palette:overlay', name: 'layout.overlay', order: 100 }, Palette)
  // Opening the palette is a command like any other: registered here because
  // the palette owns the open state, bound here so `mod+k` needs no extra path.
  // `showOverlay` closes the other overlays (v0.7: the seat is a list, and one
  // command surface is up at a time).
  commands.register({
    id: 'palette.toggle',
    title: '打开命令面板',
    run: () => toggleOverlay(OVERLAY_ID),
  })
  commands.bind({ keys: 'mod+k', command: 'palette.toggle' })
  // Go to line (§3.11): the palette opened **with the colon typed**, so the
  // reader lands in the one mode that is about a line. `:shift+;` because the
  // binding spells the keycap, and ⇧; is what types a colon (see `SHIFTED`).
  commands.register({
    id: 'palette.goToLine',
    title: '跳转到行…',
    run: () => showOverlay(OVERLAY_ID, ':'),
  })
  commands.bind({ keys: 'shift+;', command: 'palette.goToLine' })
}

/**
 * `ctx.commands` when this context is a page (client kernel), else `undefined`.
 * One module serves both halves, and Cordis throws on reading a service that is
 * neither provided nor injected — so the server half asks instead of assuming.
 */
function clientCommands(ctx: Context): CommandsService | undefined {
  try {
    return (ctx as unknown as { commands?: CommandsService }).commands
  } catch {
    return undefined
  }
}
