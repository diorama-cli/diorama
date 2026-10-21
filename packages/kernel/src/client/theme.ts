/**
 * `ctx.theme` (contract.md §3.10): which colour scheme the page paints with,
 * and the themes a piece may add.
 *
 * Kernel infrastructure like `ctx.commands` and `ctx.router`: a page that
 * cannot follow the system or remember a choice is broken in a way no plugin
 * should have to repair. A piece *adds* a theme through {@link ThemeService.register};
 * the light and dark palettes themselves belong to the stylesheet
 * (`diorama-ui/styles.css`), so a theme is always a **partial** override of the
 * custom properties that stylesheet defines (`--dio-bg`, `--dio-text`, …).
 *
 * One state, three faces:
 * - `localStorage` (`diorama.theme`) remembers the choice across reloads;
 * - the URL hash (`#theme=dark`, contract.md §3.8) makes it shareable;
 * - the document's `data-scheme` / `data-theme` attributes are what CSS sees.
 *
 * `system` is the default: the page follows `prefers-color-scheme` and repaints
 * when the OS changes, with no user action. The shell also reads the same
 * storage key in `index.html` before first paint, so a dark page never flashes
 * white (the key is spelled out there; keep the two in step).
 *
 * Pure state + a small injected host, so the resolution rules are unit-testable
 * without a browser.
 */
import type { RouterStateSlot } from './router.ts'

declare module 'cordis' {
  interface Context {
    /** The page's colour scheme and the registered themes. Provided by the kernel. */
    theme: ThemeService
  }
}

/** The scheme the page paints with. */
export type ThemeScheme = 'light' | 'dark'

/** The built-in choices; any other value names a registered theme. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** Where the choice is remembered between reloads (shared with `index.html`). */
export const THEME_STORAGE_KEY = 'diorama.theme'

/**
 * Where the **resolved** scheme is remembered, so `index.html` can paint the
 * right colours before the bundle arrives — including for a theme, whose scheme
 * the shell cannot work out from its id. Written on every paint.
 */
export const THEME_SCHEME_STORAGE_KEY = 'diorama.theme.scheme'

/** The hash key the choice is published under (contract.md §3.8). */
export const THEME_HASH_KEY = 'theme'

/**
 * A theme a piece adds. `id` is what the hash stores and what a command id is
 * built from, so it is URL-safe and colon-free: `<plugin-id>-<name>`.
 */
export interface ThemeDefinition {
  /** Globally unique, `[A-Za-z0-9_.-]+` (the hash key charset). */
  readonly id: string
  /** Human label (palette row, diagnostics). */
  readonly title: string
  /** Which scheme this theme is for; picking it pins that scheme. */
  readonly scheme: ThemeScheme
  /**
   * CSS custom properties applied to `<html>` while this theme is on, e.g.
   * `{ '--dio-bg': '#101418' }`. Partial: anything omitted keeps the
   * stylesheet's value for the scheme.
   */
  readonly tokens: Readonly<Record<string, string>>
  /** Ascending, ties broken by `id`. Default `100`. */
  readonly order?: number
}

/** What a render sees; replaced on every change, never mutated in place. */
export interface ThemeSnapshot {
  /** `system`, `light`, `dark`, or the id of a registered theme. */
  preference: string
  /** The scheme painted right now (after `system` and a theme are resolved). */
  scheme: ThemeScheme
  /** The registered theme that wins, if any (absent = the stylesheet's own). */
  theme: string | undefined
}

/** The outcome of resolving a preference against the registry. */
export interface ResolvedTheme {
  scheme: ThemeScheme
  theme: string | undefined
  tokens: Readonly<Record<string, string>> | undefined
  /** The preference names a theme nobody has registered (yet). */
  missing: boolean
}

/**
 * Resolve a preference to the scheme and theme to paint. Pure: the same inputs
 * always give the same answer, which is what the unit tests pin down.
 *
 * A preference naming an unregistered theme falls back to the **system**
 * scheme rather than to light: the theme may still arrive (a piece can register
 * after boot), and until it does the page keeps following the OS.
 */
export function resolveTheme(
  preference: string,
  system: ThemeScheme,
  themes: readonly ThemeDefinition[],
): ResolvedTheme {
  if (preference === 'system') return { scheme: system, theme: undefined, tokens: undefined, missing: false }
  if (preference === 'light' || preference === 'dark') {
    return { scheme: preference, theme: undefined, tokens: undefined, missing: false }
  }
  const found = themes.find(theme => theme.id === preference)
  if (found === undefined) return { scheme: system, theme: undefined, tokens: undefined, missing: true }
  return { scheme: found.scheme, theme: found.id, tokens: found.tokens, missing: false }
}

/** The next preference `cycle()` picks (system → light → dark → system). */
export function nextPreference(preference: string): string {
  const order = ['system', 'light', 'dark']
  const index = order.indexOf(preference)
  // A theme is a detour: the next step returns to following the system.
  return index === -1 ? 'system' : (order[(index + 1) % order.length] as string)
}

/** One paint request: everything CSS needs, already resolved. */
export interface ThemePaint {
  scheme: ThemeScheme
  theme: string | undefined
  tokens: Readonly<Record<string, string>> | undefined
}

/**
 * The browser's side of the service, injected so the rules above stay pure.
 * A host may be a no-op (the server tree, a unit test): the state machine still
 * runs, nothing is painted.
 */
export interface ThemeHost {
  /** The remembered choice, if any (a blocked storage answers `undefined`). */
  stored(): string | undefined
  /** Remember the choice and the scheme it resolved to. */
  store(preference: string, scheme: ThemeScheme): void
  /** The OS's scheme right now. */
  system(): ThemeScheme
  /** Subscribe to OS changes; returns the unsubscriber. */
  watchSystem(listener: (scheme: ThemeScheme) => void): () => void
  paint(paint: ThemePaint): void
}

/** A host that remembers and paints nothing (no document, no storage). */
export function inertThemeHost(): ThemeHost {
  return {
    stored: () => undefined,
    store: () => {},
    system: () => 'light',
    watchSystem: () => () => {},
    paint: () => {},
  }
}

/** The page's host: `localStorage`, `matchMedia`, and the document's attributes. */
export function browserThemeHost(): ThemeHost | undefined {
  if (typeof document === 'undefined') return undefined
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : undefined
  // The custom properties this host wrote last time, so switching themes does
  // not leave the previous theme's tokens behind.
  let applied: string[] = []
  return {
    stored() {
      try {
        const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
        return value === null || value === undefined ? undefined : value
      } catch {
        // A blocked storage (private mode, a sandboxed frame) is not an error:
        // the choice just does not survive a reload.
        return undefined
      }
    },
    store(preference, scheme) {
      try {
        globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference)
        globalThis.localStorage?.setItem(THEME_SCHEME_STORAGE_KEY, scheme)
      } catch {
        // Same as above: remember nothing rather than break the page.
      }
    },
    system() {
      return media?.matches === true ? 'dark' : 'light'
    },
    watchSystem(listener) {
      if (media === undefined) return () => {}
      const handler = (): void => listener(media.matches ? 'dark' : 'light')
      media.addEventListener('change', handler)
      return () => media.removeEventListener('change', handler)
    },
    paint({ scheme, theme, tokens }) {
      const root = document.documentElement
      root.setAttribute('data-scheme', scheme)
      for (const name of applied) root.style.removeProperty(name)
      applied = []
      if (theme === undefined) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', theme)
      for (const [name, value] of Object.entries(tokens ?? {})) {
        // Only custom properties: a theme is tokens, not arbitrary CSS.
        if (!name.startsWith('--')) continue
        root.style.setProperty(name, value)
        applied.push(name)
      }
    },
  }
}

/** The service face pieces see. */
export interface ThemeService {
  /** Immutable snapshot for `useSyncExternalStore`. */
  getSnapshot(): ThemeSnapshot
  subscribe(listener: () => void): () => void
  /** Set the preference (`system`, `light`, `dark`, or a registered theme id). */
  set(preference: string): void
  /** system → light → dark → system (a theme goes back to `system`). */
  cycle(): string
  /** Add a theme; the returned disposer removes it. */
  register(definition: ThemeDefinition): () => void
  /** Every registered theme, in `order` / `id` order. */
  themes(): readonly ThemeDefinition[]
  /** Whether a theme id is registered. */
  has(id: string): boolean
  /** Subscribe to registry changes (a theme appeared or went away). */
  subscribeThemes(listener: () => void): () => void
}

export interface ThemeOptions {
  host?: ThemeHost
  /** The `theme` hash slot (contract.md §3.8); absent outside a page. */
  hash?: RouterStateSlot
  /** Sink for a preference that names no registered theme. */
  warn?(message: string): void
}

/** `[A-Za-z0-9_.-]+`: URL-safe, colon-free (a command id is built from it). */
const ID_PATTERN = /^[A-Za-z0-9_.-]+$/

/** The service. One per page, provided by the kernel on the client tree. */
export class Themes implements ThemeService {
  private preference: string
  private snapshot: ThemeSnapshot
  private readonly registered = new Map<string, ThemeDefinition>()
  private readonly listeners = new Set<() => void>()
  private readonly themeListeners = new Set<() => void>()
  private readonly warned = new Set<string>()
  private readonly host: ThemeHost
  private readonly stopSystem: () => void
  private readonly stopHash: (() => void) | undefined

  constructor(private readonly options: ThemeOptions = {}) {
    this.host = options.host ?? inertThemeHost()
    // The URL wins over the remembered choice: a shared link shows what it says.
    const fromHash = options.hash?.get()
    this.preference = normalizePreference(fromHash ?? this.host.stored())
    this.snapshot = { preference: this.preference, scheme: 'light', theme: undefined }
    this.paint()
    this.stopSystem = this.host.watchSystem(() => {
      if (this.preference === 'system') this.paint()
    })
    this.stopHash = options.hash?.onChange(value => this.set(value === undefined ? 'system' : value))
  }

  getSnapshot = (): ThemeSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeThemes = (listener: () => void): (() => void) => {
    this.themeListeners.add(listener)
    return () => {
      this.themeListeners.delete(listener)
    }
  }

  set(preference: string): void {
    const next = normalizePreference(preference)
    this.preference = next
    // Paint first: it resolves the scheme and remembers both halves, so a
    // reload's `index.html` has the answer before the bundle runs.
    this.paint()
    const slot = this.options.hash
    if (slot === undefined) return
    const target = next === 'system' ? undefined : next
    if (slot.get() !== target) slot.set(target)
  }

  cycle(): string {
    const next = nextPreference(this.preference)
    this.set(next)
    return next
  }

  register(definition: ThemeDefinition): () => void {
    const id = definition?.id
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new TypeError(
        `theme.register: "id" must match ${ID_PATTERN.source} (it is a hash value and a command id) — got ${JSON.stringify(id)}`,
      )
    }
    if (definition.scheme !== 'light' && definition.scheme !== 'dark') {
      throw new TypeError(`theme.register: "${id}" must declare scheme "light" or "dark"`)
    }
    if (definition.tokens === null || typeof definition.tokens !== 'object') {
      throw new TypeError(`theme.register: "${id}" must declare a "tokens" object`)
    }
    if (this.registered.has(id)) {
      throw new Error(`theme.register: id "${id}" is already registered (ids are global; prefix with the plugin id)`)
    }
    const stored: ThemeDefinition = {
      id,
      title: typeof definition.title === 'string' && definition.title !== '' ? definition.title : id,
      scheme: definition.scheme,
      tokens: { ...definition.tokens },
      order: typeof definition.order === 'number' ? definition.order : 100,
    }
    this.registered.set(id, stored)
    // A preference that named this id before it existed resolves now.
    this.paint()
    this.notifyThemes()
    return () => {
      if (this.registered.get(id) !== stored) return
      this.registered.delete(id)
      this.paint()
      this.notifyThemes()
    }
  }

  themes(): readonly ThemeDefinition[] {
    return [...this.registered.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
    )
  }

  has(id: string): boolean {
    return this.registered.has(id)
  }

  /** Stop following the OS and the hash (the page is going away). */
  dispose(): void {
    this.stopSystem()
    this.stopHash?.()
    this.listeners.clear()
    this.themeListeners.clear()
  }

  /** Resolve, paint, publish — the one place the three happen together. */
  private paint(): void {
    const resolved = resolveTheme(this.preference, this.host.system(), this.themes())
    if (resolved.missing && !this.warned.has(this.preference)) {
      this.warned.add(this.preference)
      this.options.warn?.(
        `theme: no theme "${this.preference}" is registered; following the system scheme until one is`,
      )
    }
    this.host.paint({ scheme: resolved.scheme, theme: resolved.theme, tokens: resolved.tokens })
    this.host.store(this.preference, resolved.scheme)
    const next: ThemeSnapshot = {
      preference: this.preference,
      scheme: resolved.scheme,
      theme: resolved.theme,
    }
    const changed =
      next.preference !== this.snapshot.preference ||
      next.scheme !== this.snapshot.scheme ||
      next.theme !== this.snapshot.theme
    this.snapshot = next
    if (!changed) return
    for (const listener of [...this.listeners]) listener()
  }

  private notifyThemes(): void {
    for (const listener of [...this.themeListeners]) listener()
  }
}

/** Anything that is not a non-empty string means "no choice yet". */
function normalizePreference(value: string | undefined | null): string {
  return typeof value === 'string' && value !== '' ? value : 'system'
}

/** Create the service (the kernel provides it; pieces only consume it). */
export function createThemeService(options: ThemeOptions = {}): Themes {
  return new Themes(options)
}
