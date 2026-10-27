import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createThemeService,
  nextPreference,
  resolveTheme,
  type ThemeDefinition,
  type ThemeHost,
  type ThemeScheme,
} from '../src/client/theme.ts'

/**
 * `ctx.theme` (contract.md §3.10): the resolution rules, the persistence and
 * the theme registry — without a browser, through an injected host.
 */

const DARK_THEME: ThemeDefinition = {
  id: 'night-owl',
  title: 'Night Owl',
  scheme: 'dark',
  tokens: { '--dio-bg': '#011627', '--dio-accent': '#82aaff' },
}

/** A host that records what the service asked it to do (no browser). */
interface RecordingHost extends ThemeHost {
  paints: { scheme: string; theme: string | undefined; tokens: Readonly<Record<string, string>> | undefined }[]
  writes: { preference: string; scheme: string }[]
  /** Test hook: change the OS scheme and notify. */
  setSystem(scheme: ThemeScheme): void
  /** Test hook: what the page remembers (what `index.html` would read). */
  remembered: { preference?: string; scheme?: string }
}

function recorder(options: { system?: ThemeScheme; remembered?: string } = {}): RecordingHost {
  let scheme: ThemeScheme = options.system ?? 'light'
  let listener: ((scheme: ThemeScheme) => void) | undefined
  const host: RecordingHost = {
    paints: [],
    writes: [],
    remembered: { ...(options.remembered === undefined ? {} : { preference: options.remembered }) },
    stored: () => host.remembered.preference,
    store: (preference, resolved) => {
      host.remembered = { preference, scheme: resolved }
      host.writes.push({ preference, scheme: resolved })
    },
    system: () => scheme,
    watchSystem: callback => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    paint: paint => {
      host.paints.push(paint)
    },
    setSystem: next => {
      scheme = next
      listener?.(next)
    },
  }
  return host
}

test('theme: resolveTheme follows the system, pins an explicit scheme, and applies a theme', () => {
  assert.deepEqual(resolveTheme('system', 'dark', []), { scheme: 'dark', theme: undefined, tokens: undefined, missing: false })
  assert.deepEqual(resolveTheme('system', 'light', []), { scheme: 'light', theme: undefined, tokens: undefined, missing: false })
  assert.deepEqual(resolveTheme('dark', 'light', []), { scheme: 'dark', theme: undefined, tokens: undefined, missing: false })
  assert.deepEqual(resolveTheme('light', 'dark', []), { scheme: 'light', theme: undefined, tokens: undefined, missing: false })
  // A theme pins its own scheme and carries its tokens.
  assert.deepEqual(resolveTheme('night-owl', 'light', [DARK_THEME]), {
    scheme: 'dark',
    theme: 'night-owl',
    tokens: DARK_THEME.tokens,
    missing: false,
  })
  // Unknown theme: follow the system until the piece that owns it shows up.
  assert.deepEqual(resolveTheme('not-yet', 'dark', []), { scheme: 'dark', theme: undefined, tokens: undefined, missing: true })
})

test('theme: nextPreference cycles system → light → dark → system, and a theme goes back to system', () => {
  assert.equal(nextPreference('system'), 'light')
  assert.equal(nextPreference('light'), 'dark')
  assert.equal(nextPreference('dark'), 'system')
  assert.equal(nextPreference('night-owl'), 'system')
  assert.equal(nextPreference(''), 'system')
})

test('theme: the default is "system", and the OS decides the scheme', () => {
  const host = recorder({ system: 'dark' })
  const service = createThemeService({ host })
  assert.equal(service.getSnapshot().preference, 'system')
  assert.equal(service.getSnapshot().scheme, 'dark')
  assert.equal(service.getSnapshot().theme, undefined)
  // The first paint already happened (before any piece rendered).
  assert.equal(host.paints.length, 1)
  service.dispose()
})

test('theme: a remembered choice wins over the system, and a change is remembered', () => {
  const host = recorder({ system: 'light', remembered: 'dark' })
  const service = createThemeService({ host })
  assert.equal(service.getSnapshot().preference, 'dark')
  assert.equal(service.getSnapshot().scheme, 'dark')

  service.set('light')
  assert.equal(service.getSnapshot().scheme, 'light')
  // Remembered as a pair: the choice, and the scheme it resolved to (what
  // `index.html` reads before the bundle runs).
  assert.deepEqual(host.writes.at(-1), { preference: 'light', scheme: 'light' })
  service.dispose()
})

test('theme: following the system repaints when the OS changes; a pinned scheme does not', () => {
  const host = recorder({ system: 'light' })
  const service = createThemeService({ host })
  const seen: string[] = []
  service.subscribe(() => seen.push(service.getSnapshot().scheme))

  host.setSystem('dark')
  assert.equal(service.getSnapshot().scheme, 'dark')
  assert.deepEqual(seen, ['dark'])

  service.set('light')
  ;(host as unknown as { setSystem(scheme: 'light' | 'dark'): void }).setSystem('light')
  host.setSystem('dark')
  // Pinned: the OS flipping dark does not move the page.
  assert.equal(service.getSnapshot().scheme, 'light')
  service.dispose()
})

test('theme: cycle() walks the three built-in choices and publishes each', () => {
  const host = recorder({ system: 'light' })
  const service = createThemeService({ host })
  assert.equal(service.cycle(), 'light')
  assert.equal(service.cycle(), 'dark')
  assert.equal(service.cycle(), 'system')
  assert.equal(service.getSnapshot().preference, 'system')
  service.dispose()
})

test('theme: a registered theme pins its scheme, applies its tokens, and leaves with its disposer', () => {
  const host = recorder({ system: 'light' })
  const service = createThemeService({ host })
  const dispose = service.register(DARK_THEME)
  assert.equal(service.has('night-owl'), true)
  assert.deepEqual(service.themes().map(theme => theme.id), ['night-owl'])

  service.set('night-owl')
  assert.deepEqual(service.getSnapshot(), { preference: 'night-owl', scheme: 'dark', theme: 'night-owl' })
  assert.deepEqual(host.paints.at(-1)?.tokens, DARK_THEME.tokens)
  // Remembered with the scheme the theme resolved to (dark), so a reload does
  // not flash the OS scheme first.
  assert.deepEqual(host.writes.at(-1), { preference: 'night-owl', scheme: 'dark' })

  dispose()
  assert.equal(service.has('night-owl'), false)
  // The choice survives, the theme does not: the page follows the system again
  // rather than falling back to light.
  assert.equal(service.getSnapshot().preference, 'night-owl')
  assert.equal(service.getSnapshot().theme, undefined)
  assert.equal(service.getSnapshot().scheme, 'light')
  service.dispose()
})

test('theme: registering the theme a preference already named resolves it without a new choice', () => {
  const host = recorder({ system: 'light' })
  const service = createThemeService({ host })
  service.set('night-owl')
  assert.equal(service.getSnapshot().theme, undefined)
  assert.equal(service.getSnapshot().scheme, 'light')

  let registryChanges = 0
  service.subscribeThemes(() => registryChanges++)
  service.register(DARK_THEME)
  assert.equal(registryChanges, 1)
  assert.equal(service.getSnapshot().theme, 'night-owl')
  assert.equal(service.getSnapshot().scheme, 'dark')
  service.dispose()
})

test('theme: a duplicate id throws; a malformed one is refused loudly', () => {
  const service = createThemeService({ host: recorder() })
  service.register(DARK_THEME)
  assert.throws(() => service.register(DARK_THEME), /already registered/)
  assert.throws(() => service.register({ ...DARK_THEME, id: 'has:colon' }), /must match/)
  assert.throws(() => service.register({ ...DARK_THEME, id: '' }), /must match/)
  assert.throws(
    () => service.register({ ...DARK_THEME, scheme: 'sepia' as unknown as 'dark' }),
    /scheme "light" or "dark"/,
  )
  service.dispose()
})

test('theme: themes() sorts by order then id, so a palette row list is stable', () => {
  const service = createThemeService({ host: recorder() })
  service.register({ ...DARK_THEME, id: 'zebra', order: 10 })
  service.register({ ...DARK_THEME, id: 'alpha', order: 10 })
  service.register({ ...DARK_THEME, id: 'later', order: 20 })
  assert.deepEqual(service.themes().map(theme => theme.id), ['alpha', 'zebra', 'later'])
  service.dispose()
})

test('theme: the hash is the source of truth on boot, and set() writes it back', () => {
  let value: string | undefined = 'dark'
  const listeners = new Set<(value: string | undefined) => void>()
  const slot = {
    get: () => value,
    set: (next: string | undefined) => {
      value = next
      for (const listener of [...listeners]) listener(next)
    },
    onChange: (listener: (value: string | undefined) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const service = createThemeService({ host: recorder({ system: 'light' }), hash: slot })
  // A shared link shows what it says, even when storage disagrees.
  assert.equal(service.getSnapshot().preference, 'dark')

  service.set('system')
  // "Follow the system" is the absence of a hash entry, not `#theme=system`.
  assert.equal(value, undefined)
  assert.equal(service.getSnapshot().preference, 'system')

  // Back/forward moves the page too.
  slot.set('light')
  assert.equal(service.getSnapshot().preference, 'light')
  service.dispose()
})

test('theme: with nothing chosen the page starts at the configured default, and does not remember it', () => {
  // `[ui] theme = "dark"` (contract.md §4.1): a start, not a choice.
  const host = recorder({ system: 'light' })
  const service = createThemeService({ host, fallback: 'dark' })
  assert.equal(service.getSnapshot().preference, 'dark')
  assert.equal(service.getSnapshot().scheme, 'dark')
  // The scheme is remembered (the shell paints from it before the bundle),
  // but no preference is: a remembered default would outlive the file.
  assert.deepEqual(host.writes.at(-1), { preference: undefined, scheme: 'dark' })
  assert.equal(host.remembered.preference, undefined)

  // A reader's choice wins over the file, from then on.
  service.set('light')
  assert.equal(service.getSnapshot().scheme, 'light')
  assert.deepEqual(host.writes.at(-1), { preference: 'light', scheme: 'light' })
  service.dispose()
})

test('theme: a remembered choice outranks the configured default; the URL outranks both', () => {
  const remembered = createThemeService({ host: recorder({ system: 'light', remembered: 'light' }), fallback: 'dark' })
  assert.equal(remembered.getSnapshot().preference, 'light')
  remembered.dispose()

  const fromHash = createThemeService({
    host: recorder({ system: 'light', remembered: 'light' }),
    hash: { get: () => 'dark', set: () => {}, onChange: () => () => {} },
    fallback: 'system',
  })
  assert.equal(fromHash.getSnapshot().preference, 'dark')
  fromHash.dispose()
})

test('theme: a preference naming no theme warns once, not on every repaint', () => {
  const warnings: string[] = []
  const host = recorder({ system: 'dark' })
  const service = createThemeService({ host, warn: message => warnings.push(message) })
  service.set('ghost')
  service.set('ghost')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /no theme "ghost"/)
  service.dispose()
})
