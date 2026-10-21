/**
 * theme — the commands that pick a colour scheme (contract.md §3.10).
 *
 * A piece like `palette`, not a kernel feature: the **state** is the kernel's
 * `ctx.theme` (the page follows the system until someone chooses, remembers the
 * choice, and publishes it in the URL hash), and this piece only registers the
 * commands and the one shortcut. Removing it leaves the page following the
 * system scheme — and a theme registered by some other piece still works,
 * because the service, not this piece, owns the state.
 *
 * A registered theme gets a command of its own here, so it shows up in the
 * palette without the piece that added it writing any UI: `theme.use:<id>`.
 * That is the third-party extension point — a theme is **data** (custom
 * properties), so nothing in this file, or in `diorama-ui`, has to know its
 * name.
 */
import type { Context } from 'cordis'
import type { CommandsService, ThemeService } from 'diorama-kernel/client'

export const name = 'theme'
export const inject = ['slots']

/** Command ids (contract.md §3.7: `<plugin-id>.<command>` for built-ins). */
export const CYCLE_COMMAND = 'theme.cycle'
export const SYSTEM_COMMAND = 'theme.useSystem'
export const LIGHT_COMMAND = 'theme.useLight'
export const DARK_COMMAND = 'theme.useDark'

/** The command that picks a registered theme (`theme.use:<theme id>`). */
export function themeCommandId(themeId: string): string {
  return `theme.use:${themeId}`
}

export function apply(ctx: Context) {
  // Client-only: `ctx.commands` / `ctx.theme` are page services, and reading a
  // service this context neither provides nor injects throws on the server.
  const commands = clientCommands(ctx)
  const theme = clientTheme(ctx)
  if (commands === undefined || theme === undefined) return

  commands.register({
    id: CYCLE_COMMAND,
    title: '主题：跟随系统 / 亮色 / 暗色',
    run: () => {
      theme.cycle()
    },
  })
  // ⌘⌥T on a Mac arrives as `†` (Option composes): the kernel falls back to the
  // physical key for `alt` bindings, so this works on both platforms
  // (contract.md §3.7).
  commands.bind({ keys: 'mod+alt+t', command: CYCLE_COMMAND })

  const fixed = [
    { id: SYSTEM_COMMAND, title: '主题：跟随系统', preference: 'system' },
    { id: LIGHT_COMMAND, title: '主题：亮色', preference: 'light' },
    { id: DARK_COMMAND, title: '主题：暗色', preference: 'dark' },
  ] as const
  for (const entry of fixed) {
    commands.register({
      id: entry.id,
      title: entry.title,
      run: () => {
        theme.set(entry.preference)
      },
    })
  }

  // One command per registered theme, kept in step with the registry: a piece
  // that adds a theme gets its palette row for free, and a theme that goes away
  // takes its command with it.
  const disposers = new Map<string, () => void>()
  const sync = (): void => {
    const live = new Set<string>()
    for (const definition of theme.themes()) {
      live.add(definition.id)
      if (disposers.has(definition.id)) continue
      disposers.set(
        definition.id,
        commands.register({
          id: themeCommandId(definition.id),
          title: `主题：${definition.title}`,
          run: () => {
            theme.set(definition.id)
          },
        }),
      )
    }
    for (const [id, dispose] of [...disposers]) {
      if (live.has(id)) continue
      dispose()
      disposers.delete(id)
    }
  }
  sync()
  ctx.effect(
    () => {
      const stop = theme.subscribeThemes(sync)
      return () => {
        stop()
        for (const dispose of disposers.values()) dispose()
        disposers.clear()
      }
    },
    'theme: commands for registered themes',
  )
}

/** `ctx.commands` when this context is a page (client kernel), else `undefined`. */
function clientCommands(ctx: Context): CommandsService | undefined {
  try {
    return (ctx as unknown as { commands?: CommandsService }).commands
  } catch {
    return undefined
  }
}

/** `ctx.theme` when this context is a page (client kernel), else `undefined`. */
function clientTheme(ctx: Context): ThemeService | undefined {
  try {
    return (ctx as unknown as { theme?: ThemeService }).theme
  } catch {
    return undefined
  }
}
