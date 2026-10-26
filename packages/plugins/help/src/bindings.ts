/**
 * The shortcut sheet's data (contract.md §3.7, §5).
 *
 * Pure functions only: `node --test` cannot load `.tsx` (docs/m4/spec.md §9
 * trap 1), so everything the sheet computes lives here and the component in
 * `index.tsx` only draws it.
 *
 * The **notation → text** half used to live here too. It moved to the kernel
 * (`diorama-kernel/client`'s `formatKeys`) when controls started showing their
 * own shortcuts (contract.md §3.7, v0.15): two tables that print `⌘⌥W` would
 * drift the first time one of them learned a new key name.
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
