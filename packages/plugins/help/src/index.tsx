/**
 * help — the shortcut sheet (contract.md §3.7, §5).
 *
 * A piece like the palette, not a kernel feature: it registers one entry in
 * `layout.overlay` and **reads** `ctx.commands`. It adds no registry, no
 * binding table and no `keydown` listener of its own — `?` is a command binding
 * like `mod+k`, dispatched by the kernel's one listener (contract.md §3.7).
 *
 * It lists **every** binding, including the ones whose command is unavailable
 * right now (those rows are dimmed): the sheet answers "which keys exist?", and
 * hiding half of them because no tab is open would make it useless as a
 * reference. That is the one deliberate difference from the palette, which only
 * lists what it can run.
 *
 * The sheet and the palette take turns: both register into the `layout.overlay`
 * list seat and both ask the page-global `overlayStore` (diorama-ui) whether
 * they are the one that is up, so opening one closes the other.
 */
import type { Context } from 'cordis'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { formatKeys, isApplePlatform, type CommandsService } from 'diorama-kernel/client'
import { hideOverlay, overlayOpen, overlayStore, provideEntry, toggleOverlay, useKernel } from 'diorama-ui'
import { shortcutRows } from './bindings.ts'

export const name = 'help'
export const inject = ['slots']

/** This overlay's id in the page's overlay store (see `diorama-ui/overlay`). */
export const OVERLAY_ID = 'help'

/** Whether this overlay is the one that is up (a primitive snapshot). */
function useOpen(): boolean {
  return useSyncExternalStore(overlayStore.subscribe, overlayStore.getSnapshot, overlayStore.getSnapshot) === OVERLAY_ID
}

function ShortcutSheet() {
  const kernel = useKernel()
  const commands = kernel.ctx.commands as unknown as CommandsService
  const snapshot = useSyncExternalStore(commands.subscribe, commands.getSnapshot, commands.getSnapshot)
  const open = useOpen()
  const panel = useRef<HTMLDivElement | null>(null)

  // Focus the panel when it opens: Escape is handled by the sheet's own
  // keydown (the panel is not a text field, so the kernel would otherwise
  // dispatch Escape to whatever binding claims it).
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => panel.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  if (!open) return null

  const apple = isApplePlatform()
  const rows = shortcutRows(snapshot.commands, snapshot.bindings, id => commands.canRun(id))

  return (
    <div className="diorama-help" data-testid="help" role="dialog" aria-modal="true" aria-label="快捷键说明">
      <div className="diorama-help__backdrop" onClick={() => hideOverlay(OVERLAY_ID)} />
      <div
        className="diorama-help__panel"
        ref={panel}
        // Focusable so a screen reader announces the dialog. Escape is a
        // command binding (`help.close`), not a handler here: the panel is not
        // a text field, so the kernel's dispatcher reaches it, and the binding
        // also works when focus has wandered off the panel.
        tabIndex={-1}
      >
        <header className="diorama-help__header">
          <h2 className="diorama-help__title">快捷键说明</h2>
          <span className="diorama-help__hint">按 Esc 或 ? 关闭</span>
        </header>
        <ul className="diorama-help__list" data-testid="help-list">
          {rows.map(row => (
            <li
              key={row.id}
              className={`diorama-help__row${row.available ? '' : ' diorama-help__row--unavailable'}`}
              data-command={row.id}
              // Dimmed, not hidden (the palette does the opposite, §3.7).
              data-available={row.available ? 'true' : 'false'}
            >
              <span className="diorama-help__keys">
                {row.keys.map(keys => (
                  <kbd key={keys} className="diorama-help__key" data-keys={keys}>
                    {formatKeys(keys, apple)}
                  </kbd>
                ))}
              </span>
              <span className="diorama-help__title">{row.title}</span>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="diorama-help__empty" data-testid="help-empty">
              没有已绑定的快捷键
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}

export function apply(ctx: Context) {
  // A client-only kernel service: absent in the server tree, where this piece
  // contributes nothing (and must not fail to activate).
  const commands = clientCommands(ctx)
  if (commands === undefined) return
  provideEntry(ctx, { id: 'help:overlay', name: 'layout.overlay', order: 200 }, ShortcutSheet)
  // `?` is Shift+/ on a US layout, and the kernel's key notation names the
  // **event key** with modifiers matched exactly (contract.md §3.7): the
  // binding has to say `shift+?`, or it would only answer a synthetic event
  // whose `shiftKey` is false.
  commands.register({
    id: 'help.toggle',
    title: '快捷键说明',
    run: () => toggleOverlay(OVERLAY_ID),
  })
  commands.bind({ keys: 'shift+?', command: 'help.toggle' })
  // Escape closes the sheet — and only while it is up, so the key stays
  // untouched for the browser and for any other surface otherwise (a binding
  // inherits its command's `when`, commands.ts §bind).
  commands.register({
    id: 'help.close',
    title: '关闭快捷键说明',
    when: () => overlayOpen(OVERLAY_ID),
    run: () => hideOverlay(OVERLAY_ID),
  })
  commands.bind({ keys: 'escape', command: 'help.close' })
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
