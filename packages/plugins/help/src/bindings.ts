/**
 * The shortcut sheet's data (contract.md §3.7, §5).
 *
 * Pure functions only: `node --test` cannot load `.tsx` (docs/m4/spec.md §9
 * trap 1), so everything the sheet computes lives here and the component in
 * `index.tsx` only draws it.
 */

/** One command as the registry snapshot exposes it. */
export interface ShortcutCommand {
  id: string
  title: string
}

/** One binding as the registry snapshot exposes it. */
export interface ShortcutBinding {
  keys: string
  command: string
}

/** One row of the sheet: a command and every key that runs it. */
export interface ShortcutRow {
  /** Command id (`tabs.close`, …). */
  id: string
  /** The command's title, as the registry has it. */
  title: string
  /** Canonical binding texts, in registration order (may be empty). */
  keys: readonly string[]
  /** Whether the command's `when` accepts the context right now. */
  available: boolean
}

const KEY_LABELS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  tab: 'Tab',
  escape: 'Esc',
  enter: 'Enter',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Del',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
}

/**
 * Render one canonical binding (`mod+alt+w`) for a human.
 *
 * Apple platforms use the glyphs a Mac user expects, with no separators
 * (`⌘⌥W`); everywhere else spells the modifiers out and joins with `+`
 * (`Ctrl+Alt+W`). The `mod` token is what differs — `ctrl` is always `⌃` /
 * `Ctrl`, so `ctrl+tab` reads the same on both.
 */
export function formatKeys(text: string, apple: boolean): string {
  const parts = text.split('+').filter(part => part !== '')
  if (parts.length === 0) return ''
  const key = parts[parts.length - 1] as string
  const modifiers = parts.slice(0, -1)
  const label = keyLabel(key)
  if (apple) {
    const glyphs = modifiers.map(modifier => APPLE_MODIFIERS[modifier] ?? modifier).join('')
    return `${glyphs}${label}`
  }
  const words = modifiers.map(modifier => OTHER_MODIFIERS[modifier] ?? modifier)
  return [...words, label].join('+')
}

const APPLE_MODIFIERS: Record<string, string> = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
const OTHER_MODIFIERS: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }

/** The key part's label: named keys get a symbol or a word, the rest uppercase. */
function keyLabel(key: string): string {
  const named = KEY_LABELS[key]
  if (named !== undefined) return named
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * Join the registry's commands and bindings into rows, **in binding
 * registration order**: that is boot order, so the sheet groups a piece's
 * shortcuts together (all `tabs.*`, then `tree.focus`, …) instead of
 * scattering them alphabetically.
 *
 * A binding whose command is not registered is dropped (the command was
 * disposed; the binding is stale). A command with no binding is not a row:
 * the sheet is about keys, and an unbound command is the palette's business.
 * Commands that are unavailable right now **stay**, with `available: false` —
 * the reader is looking up what exists, not what happens to work in this tab.
 */
export function shortcutRows(
  commands: readonly ShortcutCommand[],
  bindings: readonly ShortcutBinding[],
  canRun: (id: string) => boolean,
): ShortcutRow[] {
  const titles = new Map(commands.map(command => [command.id, command.title]))
  const order: string[] = []
  const keysByCommand = new Map<string, string[]>()
  for (const binding of bindings) {
    if (!titles.has(binding.command)) continue
    const existing = keysByCommand.get(binding.command)
    if (existing === undefined) {
      keysByCommand.set(binding.command, [binding.keys])
      order.push(binding.command)
    } else if (!existing.includes(binding.keys)) {
      // The same key twice on one command is a no-op, not a second row.
      existing.push(binding.keys)
    }
  }
  return order.map(id => ({
    id,
    title: titles.get(id) as string,
    keys: keysByCommand.get(id) as readonly string[],
    available: canRun(id),
  }))
}
