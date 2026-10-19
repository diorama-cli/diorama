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
 */
import type { Context } from 'cordis'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CommandsService } from 'diorama-kernel/client'
import { provideEntry, useKernel } from 'diorama-ui'

export const name = 'palette'
export const inject = ['slots', 'commands']

/**
 * The palette's open state is page-local UI state; the kernel does not own it.
 * It lives on the page global (not module scope): a client half is one script
 * per page, but a test harness may boot several pages in one browser context.
 */
interface PaletteState {
  open: boolean
  listeners: Set<() => void>
}

const SCOPE = globalThis as unknown as { __diorama_palette__?: PaletteState }

function state(): PaletteState {
  SCOPE.__diorama_palette__ ??= { open: false, listeners: new Set() }
  return SCOPE.__diorama_palette__
}

function setOpen(open: boolean): void {
  const current = state()
  if (current.open === open) return
  current.open = open
  for (const listener of [...current.listeners]) listener()
}

function useOpen(): boolean {
  const current = state()
  return useSyncExternalStore(
    listener => {
      current.listeners.add(listener)
      return () => current.listeners.delete(listener)
    },
    () => current.open,
  )
}

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

function Palette() {
  const kernel = useKernel()
  const commands = kernel.ctx.commands as unknown as CommandsService
  const snapshot = useSyncExternalStore(commands.subscribe, commands.getSnapshot, commands.getSnapshot)
  const open = useOpen()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)

  // Reset the query each time it opens, and focus its field.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    const timer = setTimeout(() => input.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  if (!open) return null

  const rows = snapshot.commands
    .filter(command => commands.canRun(command.id))
    .filter(command => query === '' || fuzzy(command.title, query) || fuzzy(command.id, query))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  const active = Math.min(selected, Math.max(rows.length - 1, 0))

  const run = (id: string): void => {
    setOpen(false)
    void commands.run(id)
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
              const target = rows[active]
              if (target !== undefined) run(target.id)
            }
          }}
        />
        <ul className="diorama-palette__list" role="listbox">
          {rows.map((command, index) => (
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
              <span className="diorama-palette__id">{command.id}</span>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="diorama-palette__empty" data-testid="palette-empty">
              没有可执行的命令
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}

export function apply(ctx: Context) {
  const commands = (ctx as unknown as { commands: CommandsService }).commands
  provideEntry(ctx, { id: 'palette:overlay', name: 'layout.overlay', order: 100 }, Palette)
  // Opening the palette is a command like any other: registered here because
  // the palette owns the open state, bound here so `mod+k` needs no extra path.
  commands.register({
    id: 'palette.toggle',
    title: '打开命令面板',
    run: () => setOpen(!state().open),
  })
  commands.bind({ keys: 'mod+k', command: 'palette.toggle' })
}
