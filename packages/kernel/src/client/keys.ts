/**
 * Key notation (contract.md §3.7).
 *
 * A binding is `modifier+...+key`: `mod` (⌘ on macOS, Ctrl elsewhere), `ctrl`,
 * `alt`, `shift`, then exactly one key. The key is the lowercased
 * `KeyboardEvent.key` (`w`, `k`, `arrowleft`, `[`, `tab`). Modifiers are
 * order-independent; `mod` together with `ctrl` on the same platform is
 * ambiguous and refused.
 *
 * This module is the **one** table for the whole notation: the dispatcher
 * matches with it ({@link matchesKeys}), the shortcut sheet prints with it
 * ({@link formatKeys}), and a control that shows its own shortcut beside itself
 * asks {@link hintOf} for the one canonical binding it should display. Pieces
 * never spell modifiers themselves — a page that says `⌘` where the reader's
 * platform means `Ctrl` is a bug you can only see on someone else's machine.
 *
 * No Cordis, no React: `node --test` loads it directly.
 */

/** The parts of a keyboard event the matcher needs (small on purpose: testable). */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /**
   * The physical key (`KeyW`, `Digit1`, `Slash`). Only consulted when the
   * binding has `alt` and `key` did not match — see {@link matchesKeys}.
   */
  code?: string
}

export interface ParsedKeys {
  /** The binding as written (canonical form: fixed modifier order). */
  text: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  key: string
}

const MODIFIERS = new Set(['mod', 'ctrl', 'alt', 'shift'])

/** Whether `mod` means ⌘ on this platform. */
export function isApplePlatform(navigatorLike: { platform?: string; userAgent?: string } = globalThis.navigator ?? {}): boolean {
  const text = `${navigatorLike.platform ?? ''} ${navigatorLike.userAgent ?? ''}`
  return /mac|iphone|ipad/i.test(text)
}

/** Parse and normalise a binding; `undefined` when it is not one. */
export function parseKeys(text: string, apple = isApplePlatform()): ParsedKeys | undefined {
  const parts = text
    .split('+')
    .map(part => part.trim().toLowerCase())
    .filter(part => part !== '')
  if (parts.length < 1) return undefined
  const key = parts[parts.length - 1] as string
  const modifiers = parts.slice(0, -1)
  if (key === '' || MODIFIERS.has(key)) return undefined
  let ctrl = false
  let meta = false
  let alt = false
  let shift = false
  for (const modifier of modifiers) {
    if (!MODIFIERS.has(modifier)) return undefined
    if (modifier === 'mod') {
      if (apple) meta = true
      else ctrl = true
    } else if (modifier === 'ctrl') ctrl = true
    else if (modifier === 'alt') alt = true
    else shift = true
  }
  // `mod` + `ctrl` on mac or mod + ctrl on windows: both are "the same" key.
  if (modifiers.includes('mod') && modifiers.includes('ctrl')) return undefined
  // Canonical text keeps the modifiers as *written* for `mod`, so `mod+k` and
  // `ctrl+k` (or `meta+k`) do not describe the same physical key on every
  // platform — see the reserved `meta` below.
  const ordered = [modifiers.includes('mod') ? 'mod' : '', modifiers.includes('ctrl') ? 'ctrl' : '', alt ? 'alt' : '', shift ? 'shift' : '']
    .filter(part => part !== '')
    .join('+')
  return { text: ordered === '' ? key : `${ordered}+${key}`, ctrl, meta, alt, shift, key }
}

/**
 * Whether an event matches the binding (modifiers exact, key equal).
 *
 * **The `alt` case on macOS** (contract.md §3.7): Option is a *compose* key
 * there, so the browser reports the character it produced rather than the
 * letter that was pressed — ⌘⌥W arrives as `key: '∑'`, ⌘⌥R as `'®'`, ⌘⌥1 as
 * `'¡'`. Comparing `key` alone therefore made every `mod+alt+*` binding dead on
 * a Mac and let the key through to the browser. For a binding that asks for
 * `alt`, a miss on `key` falls back to the **physical** key (`code`), which is
 * layout-independent and unaffected by composition.
 *
 * The fallback is deliberately narrow: only `alt` bindings take it, so a
 * non-Apple layout that types a different character with Alt (AltGr) still
 * cannot fire a plain binding it did not ask for.
 */
export function matchesKeys(event: KeyEventLike, keys: ParsedKeys): boolean {
  if (event.ctrlKey !== keys.ctrl) return false
  if (event.metaKey !== keys.meta) return false
  if (event.altKey !== keys.alt) return false
  if (event.shiftKey !== keys.shift) return false
  const pressed = event.key.toLowerCase()
  if (pressed === keys.key) return true
  // `mod+shift+[`: the reader presses ⇧[ and the browser reports the *shifted*
  // character (`{`). The notation keeps the key as it is written on the keycap,
  // which is what an editor shows (contract.md §3.7).
  if (keys.shift && keys.key.length === 1 && SHIFTED[keys.key] === pressed) return true
  if (!keys.alt) return false
  return codeMatches(event.code, keys.key)
}

/**
 * What a US layout types for a punctuation key **with Shift** — `mod+shift+[`
 * is pressed as ⇧[ and arrives as `key: '{'`. Spelling the shifted character in
 * the binding instead (`mod+shift+{`) would be a chord no reader would write.
 */
const SHIFTED: Record<string, string> = {
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
  '-': '_',
  '=': '+',
  '`': '~',
}

/** `KeyboardEvent.code` names for the punctuation keys a binding may spell. */
const CODE_NAMES: Record<string, string> = {
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
}

/** Whether a `KeyboardEvent.code` names the same physical key as `key`. */
function codeMatches(code: string | undefined, key: string): boolean {
  if (code === undefined || code === '') return false
  // `KeyW` → `w`, `Digit1` → `1`; punctuation has its own spelling.
  if (code.startsWith('Key')) return code.slice(3).toLowerCase() === key
  if (code.startsWith('Digit')) return code.slice(5) === key
  const named = CODE_NAMES[code]
  if (named !== undefined) return named === key
  return code.toLowerCase() === key
}

/** One key's label: named keys get a symbol or a word, the rest uppercase. */
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

const APPLE_MODIFIERS: Record<string, string> = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
const OTHER_MODIFIERS: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }

function keyLabel(key: string): string {
  const named = KEY_LABELS[key]
  if (named !== undefined) return named
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * Render one canonical binding (`mod+alt+w`) for a human.
 *
 * Apple platforms use the glyphs a Mac user expects, with no separators
 * (`⌘⌥W`); everywhere else spells the modifiers out and joins with `+`
 * (`Ctrl+Alt+W`). The `mod` token is what differs — `ctrl` is always `⌃` /
 * `Ctrl`, so `ctrl+tab` reads the same on both.
 *
 * This is the only place the notation becomes text: the shortcut sheet and the
 * on-screen hints both print through it (contract.md §3.7, v0.15).
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

/**
 * The **one** canonical binding a control should show for a command
 * (contract.md §3.7, v0.15): the first binding the page registered for it, in
 * registration order. A command bound to several keys (or to none) still shows
 * at most one hint — a tab with three chips in it is noise, and the shortcut
 * sheet is where the full list lives.
 */
export function hintOf(bindings: readonly { keys: string; command: string }[], command: string): string | undefined {
  return bindings.find(binding => binding.command === command)?.keys
}

/**
 * Which **held** modifier turns hints on, given a key event: `'mod'` while ⌘
 * (macOS) or Ctrl is down, `'alt'` while Option / Alt is down, else
 * `undefined`. `ctrl` never answers on macOS — there ⌘ is `mod`, and ⌃ is a
 * different modifier the reader pressed on purpose.
 */
export function modifierOf(event: KeyEventLike, apple = isApplePlatform()): 'mod' | 'alt' | undefined {
  if (apple) {
    if (event.metaKey) return 'mod'
    return event.altKey ? 'alt' : undefined
  }
  if (event.ctrlKey) return 'mod'
  return event.altKey ? 'alt' : undefined
}
