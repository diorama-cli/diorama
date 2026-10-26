/**
 * `ctx.commands` (contract.md §3.7): one registry for commands and key
 * bindings. The palette is a consumer of it, not a second registry.
 *
 * The kernel provides this service on the page's root context, so it exists
 * even when no piece offers a UI for it. `CommandContext` is collected here —
 * pieces never query focus or the active tab themselves.
 *
 * The key **notation** (parsing, matching, printing) lives in `keys.ts`, which
 * `node --test` loads directly; this module adds the registry on top of it and
 * re-exports the notation so every existing import keeps working.
 */
import { formatKeys, isApplePlatform, hintOf, matchesKeys, modifierOf, parseKeys, type KeyEventLike, type ParsedKeys } from './keys.ts'

export {
  formatKeys,
  hintOf,
  isApplePlatform,
  matchesKeys,
  modifierOf,
  parseKeys,
  type KeyEventLike,
  type ParsedKeys,
}

/**
 * The context a command sees. `hints` is about the **reader's hands**, not
 * about the mount: while they hold ⌘ / Ctrl (or Option / Alt) the page shows
 * each control's shortcut beside it (contract.md §3.7, v0.15), so a command
 * that draws a control may ask "are hints up right now?".
 */
export interface CommandContext {
  mountId: string
  activeTab?: { id: string; path: string }
  activeRenderer?: string
  focus: 'tabs' | 'tree' | 'editor' | 'other'
  /** The modifier the reader is holding down, if any (see `heldModifier`). */
  hints?: 'mod' | 'alt'
}

export type CommandWhen = (context: CommandContext) => boolean

export interface CommandSpec {
  /** Globally unique: `<plugin-id>:<command>` (plugin ids contain no `:`). */
  id: string
  title: string
  when?: CommandWhen
  run(context: CommandContext): void | Promise<void>
}

export interface KeybindingSpec {
  /** `mod+alt+w`, `mod+k`, `ctrl+shift+tab`, … (see {@link parseKeys}). */
  keys: string
  command: string
  when?: CommandWhen
}

/**
 * One binding as the snapshot exposes it: the canonical text a shortcut is
 * matched by (`mod+alt+w`) and the text a human reads (`⌘⌥W` / `Ctrl+Alt+W`).
 * The formatted form is computed once, here, so a control that shows its own
 * shortcut does not re-derive the notation per render.
 */
export interface KeybindingInfo {
  keys: string
  label: string
  command: string
}

export interface CommandsSnapshot {
  commands: readonly { id: string; title: string }[]
  bindings: readonly KeybindingInfo[]
}

/** A duplicate command id: a programming error (contract.md §3.7). */
export class CommandConflictError extends Error {
  constructor(readonly id: string) {
    super(`commands.register: id "${id}" is already registered (ids are global; prefix with the plugin id)`)
    this.name = 'CommandConflictError'
  }
}

export interface CommandsOptions {
  /** Collects the context for `when` / `run` on every invocation. */
  context(): CommandContext
  /** Sink for warnings and refused registrations. Defaults to `console.warn`. */
  warn?: (message: string) => void
  /** Platform switch for `mod` (defaults to the browser platform). */
  apple?: boolean
  /** The modifier the reader is holding, for `CommandContext.hints` (defaults to none). */
  hints?(): 'mod' | 'alt' | undefined
}

interface StoredBinding {
  keys: string
  parsed: ParsedKeys
  command: string
  when?: CommandWhen
  /** Registration order: the first matching binding wins at dispatch. */
  seq: number
}

export class CommandsService {
  private readonly commands = new Map<string, CommandSpec>()
  private readonly bindings: StoredBinding[] = []
  private readonly listeners = new Set<() => void>()
  private readonly apple: boolean
  private readonly warn: (message: string) => void
  /** Sources contributed by pieces; each read builds a fresh context. */
  private readonly sources: Omit<CommandContextSources, 'mountId'>[] = []
  private revision = 0
  private snapshot: CommandsSnapshot = { commands: [], bindings: [] }
  private seq = 0

  constructor(private readonly options: CommandsOptions) {
    this.apple = options.apple ?? isApplePlatform()
    this.warn = options.warn ?? (message => console.warn(`[diorama] ${message}`))
  }

  /** Register a command; a duplicate id throws ({@link CommandConflictError}). */
  register(spec: CommandSpec): () => void {
    if (typeof spec?.id !== 'string' || spec.id === '') {
      throw new TypeError('commands.register: "id" must be a non-empty string')
    }
    if (this.commands.has(spec.id)) throw new CommandConflictError(spec.id)
    this.commands.set(spec.id, spec)
    this.publish()
    return () => {
      if (this.commands.get(spec.id) !== spec) return
      this.commands.delete(spec.id)
      this.publish()
    }
  }

  /**
   * Bind keys to a command id. A literal duplicate (same canonical keys, and a
   * `when` that can be true at the same time) **throws**: at most one command
   * answers a key in a given context (contract.md §3.7).
   */
  bind(spec: KeybindingSpec): () => void {
    const parsed = parseKeys(spec.keys, this.apple)
    if (parsed === undefined) throw new TypeError(`commands.bind: "${spec.keys}" is not a key binding`)
    const clashing = this.bindings.find(other => other.keys === parsed.text && mayCoexist(other.when, spec.when))
    if (clashing !== undefined) {
      throw new Error(
        `commands.bind: "${parsed.text}" is already bound to "${clashing.command}" (${spec.command} would never run in the same context)`,
      )
    }
    // A binding without its own `when` inherits the command's: registering a
    // command that is unavailable in this context must not make its key fire.
    const commandWhen = spec.when ?? this.commands.get(spec.command)?.when
    const binding: StoredBinding = {
      keys: parsed.text,
      parsed,
      command: spec.command,
      ...(commandWhen === undefined ? {} : { when: commandWhen }),
      seq: ++this.seq,
    }
    this.bindings.push(binding)
    this.publish()
    return () => {
      const index = this.bindings.indexOf(binding)
      if (index === -1) return
      this.bindings.splice(index, 1)
      this.publish()
    }
  }

  /** Whether `id` exists and its `when` accepts the current context. */
  canRun(id: string): boolean {
    const command = this.commands.get(id)
    if (command === undefined) return false
    return accepts(command.when, this.context())
  }

  /**
   * Run a command. Unknown ids and commands whose `when` is false do not run:
   * the caller gets `false` and a warning (a loud no-op, not a throw — a stale
   * binding must not break the page).
   */
  async run(id: string): Promise<boolean> {
    const command = this.commands.get(id)
    if (command === undefined) {
      this.warn(`commands.run: no command "${id}"`)
      return false
    }
    const context = this.context()
    if (!accepts(command.when, context)) {
      this.warn(`commands.run: "${id}" is not available in this context`)
      return false
    }
    try {
      await command.run(context)
      return true
    } catch (error) {
      this.warn(`commands.run: "${id}" failed — ${(error as Error)?.message ?? String(error)}`)
      return false
    }
  }

  /** Bindings that apply right now (for a palette's shortcut hints). */
  activeBindings(): readonly { keys: string; command: string }[] {
    const context = this.context()
    return this.bindings.filter(binding => accepts(binding.when, context) && this.commands.has(binding.command)).map(binding => ({ keys: binding.keys, command: binding.command }))
  }

  /**
   * The binding a control should advertise for a command (contract.md §3.7,
   * v0.15): the command's **first** binding, both as canonical text
   * (`mod+alt+w`, what a test looks for) and as readable text (`⌘⌥W` /
   * `Ctrl+Alt+W`, what the chip shows). `undefined` when the command is not
   * registered or has no binding.
   *
   * Whether the command is *available* right now is deliberately not asked: a
   * control that exists shows its key, and dispatch still refuses an
   * unavailable command.
   */
  bindingFor(id: string): KeybindingInfo | undefined {
    if (!this.commands.has(id)) return undefined
    return this.snapshot.bindings.find(binding => binding.command === id)
  }

  /** The readable form of {@link bindingFor} (`⌘⌥W`), or `undefined`. */
  hintFor(id: string): string | undefined {
    return this.bindingFor(id)?.label
  }

  /**
   * Handle one key event. Returns whether a command ran. When several bindings
   * match and are available, the first registered wins and the rest warn.
   */
  handleKey(event: KeyEventLike & { repeat?: boolean }): boolean {
    if (event.repeat === true) return false
    const context = this.context()
    // Only bindings whose `when` accepts *this* context answer the key: a
    // binding that is not available must let the event through untouched.
    const hits = this.bindings.filter(binding => matchesKeys(event, binding.parsed) && accepts(binding.when, context) && this.commands.has(binding.command))
    if (hits.length === 0) return false
    const [first, ...rest] = hits as [StoredBinding, ...StoredBinding[]]
    if (rest.length > 0) {
      this.warn(`commands: "${first.keys}" also matches ${rest.map(binding => `"${binding.command}"`).join(', ')}; running "${first.command}"`)
    }
    void this.run(first.command)
    return true
  }

  /**
   * Pieces contribute what only they know (the active tab from `tabs`, the
   * dispatched renderer from `renderer-registry`). Returns its disposer; the
   * most recently installed source wins.
   */
  contribute(source: Omit<CommandContextSources, 'mountId'>): () => void {
    const index = this.sources.push(source) - 1
    return () => {
      this.sources.splice(index, 1)
    }
  }

  /** Immutable snapshot for `useSyncExternalStore`. */
  getSnapshot = (): CommandsSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Bumped on every change (diagnostics). */
  get version(): number {
    return this.revision
  }

  /**
   * The context for this invocation: the kernel's base sources, overlaid by
   * what pieces contributed (later contributions win field by field).
   */
  private context(): CommandContext {
    const base = this.options.context()
    let current: CommandContext = base
    const hints = this.options.hints?.()
    if (hints !== undefined) current = { ...current, hints }
    for (const source of this.sources) {
      const activeTab = source.activeTab?.()
      const activeRenderer = source.activeRenderer?.()
      const focus = source.focus?.()
      current = {
        ...current,
        ...(activeTab === undefined ? {} : { activeTab }),
        ...(activeRenderer === undefined ? {} : { activeRenderer }),
        ...(focus === undefined ? {} : { focus }),
      }
    }
    return current
  }

  private publish(): void {
    this.revision++
    this.snapshot = {
      commands: [...this.commands.values()].map(command => ({ id: command.id, title: command.title })),
      // Every binding, not only the ones available right now: the snapshot is
      // a registry view (a palette lists the command; availability is `canRun`).
      // The readable form is computed here, once per change, because every
      // control with a hint reads it (contract.md §3.7, v0.15).
      bindings: this.bindings.map(binding => ({ keys: binding.keys, label: formatKeys(binding.keys, this.apple), command: binding.command })),
    }
    for (const listener of [...this.listeners]) listener()
  }
}

/** A command without `when` is always available; otherwise `when` must agree. */
function accepts(when: CommandWhen | undefined, context: CommandContext): boolean {
  if (when === undefined) return true
  try {
    return when(context) !== false
  } catch (error) {
    console.warn('[diorama] command when() threw:', error)
    return false
  }
}

/**
 * Whether two bindings on the same keys may coexist: only when their `when`
 * predicates can be shown to be mutually exclusive. Two plain functions are
 * assumed to overlap (the safe default: fail loud rather than shadow a key).
 */
function mayCoexist(a: CommandWhen | undefined, b: CommandWhen | undefined): boolean {
  if (a === undefined || b === undefined) return true
  const left = markerOf(a)
  return left === undefined || left !== markerOf(b)
}

/** The marker of a `when` made exclusive (see `exclusive()`). */
function markerOf(when: CommandWhen): symbol | undefined {
  return (when as unknown as { [EXCLUSIVE]?: symbol })[EXCLUSIVE]
}

/** Marks two `when` predicates as mutually exclusive for conflict checks. */
export const EXCLUSIVE = Symbol('diorama.commands.exclusive')

/**
 * Wrap a predicate so it is exclusive with `other`: a pair made by this helper
 * may share a key (e.g. "focus is in the tree" vs "focus is not in the tree").
 */
export function exclusive(when: CommandWhen, other: CommandWhen): CommandWhen {
  // Tag *both* the predicates they were given (identity is kept), so either
  // one may be registered first and the pair still reads as exclusive.
  const pair = Symbol('exclusive-pair')
  ;(when as CommandWhen & { [EXCLUSIVE]?: symbol })[EXCLUSIVE] = pair
  ;(other as CommandWhen & { [EXCLUSIVE]?: symbol })[EXCLUSIVE] = pair
  return when
}

/** Collect the page's `CommandContext` from the services it knows. */
export interface CommandContextSources {
  mountId: string
  activeTab?: () => { id: string; path: string } | undefined
  activeRenderer?: () => string | undefined
  focus?: () => CommandContext['focus']
}

export function collectCommandContext(sources: CommandContextSources): CommandContext {
  const activeTab = sources.activeTab?.()
  const activeRenderer = sources.activeRenderer?.()
  return {
    mountId: sources.mountId,
    ...(activeTab === undefined ? {} : { activeTab }),
    ...(activeRenderer === undefined ? {} : { activeRenderer }),
    focus: sources.focus?.() ?? 'other',
  }
}

declare module 'cordis' {
  interface Context {
    /** Commands and key bindings. Provided by the kernel on the page root. */
    commands: CommandsService
  }
}

/** Create the service (the kernel provides it; pieces only consume it). */
export function createCommandsService(options: CommandsOptions): CommandsService {
  return new CommandsService(options)
}
