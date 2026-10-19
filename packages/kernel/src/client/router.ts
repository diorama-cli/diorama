/**
 * `ctx.router` (client): the page's URL, what it shows, and the state other
 * pieces keep in it (contract.md §3.8).
 *
 * Two disjoint surfaces:
 *
 * - **`/~/<path>`** — *which file is being browsed*. Owned by the kernel: it
 *   is validated against the mount, written when the active **content** tab
 *   changes, and restored on refresh (a deep link / share link). A tab in
 *   another view (a diff, say) is page state, not a browsing location, so it
 *   does not move this path.
 * - **`#key=value&…`** — *page state pieces own*. A flat key/value surface any
 *   piece may write through `ctx.router.state(key)`: the router does not know
 *   what `diff` or `theme` means. The hash is restored on refresh too, but a
 *   change to it never pushes a history entry (`replaceState`): turning a
 *   switch does not add a back step.
 *
 * The router is kernel infrastructure, like `ctx.commands`: a page without it
 * loses deep links, which is not a plugin's business.
 *
 * Pure state + history access injected as small functions, so the logic is
 * unit-testable without a browser.
 */
import { ROUTE_PREFIX, type FileInfo, type RelPath } from '../shared/types.ts'

declare module 'cordis' {
  interface Context {
    /** The page's URL: the browsed file plus a hash surface for pieces. */
    router: RouterService
  }
}

export { ROUTE_PREFIX }

/** Immutable route state; replaced on every change. */
export interface RouteSnapshot {
  /** The browsed file (`/~/<path>`); `undefined` = the page root. */
  file: RelPath | undefined
  /** The hash's `key=value` pairs, decoded (a copy; parts may read it). */
  state: Readonly<Record<string, string>>
}

/**
 * A key/value slot in the URL hash owned by one piece (contract.md §3.8).
 * `get` reads; `set(undefined)` removes the key. Values are strings and must be
 * URL-safe after encoding (they are encoded); keys are `[A-Za-z0-9_.-]+`.
 */
export interface RouterStateSlot {
  get(): string | undefined
  set(value: string | undefined): void
  /** Called when the value changes (back/forward, another piece, a deep link). */
  onChange(listener: (value: string | undefined) => void): () => void
}

/** The hash surface pieces talk to. */
export interface RouterHash {
  /** One key's slot; the same key returns the same slot. */
  state(key: string): RouterStateSlot
  /** A snapshot copy of every pair (pieces that need to inspect the whole hash). */
  values(): Readonly<Record<string, string>>
}

/** What the router needs from the tabs service (the narrow face it uses). */
export interface RouterTabs {
  readonly active: { id: string; path: RelPath; view?: 'content' | 'diff' } | undefined
  /** The active tab as a call (same value); services may be read across builds. */
  activeTab?(): { id: string; path: RelPath; view?: 'content' | 'diff' } | undefined
  open(file: FileInfo): { id: string; path: RelPath }
  close(): void
  subscribe(listener: () => void): () => void
}

/** History access, injected so the router runs without a browser. */
export interface RouterHistory {
  /** Current `pathname + search + hash` of the page. */
  read(): string
  /** Record a new URL for the current page state. */
  push(url: string): void
  /** Replace the current URL without a new history entry. */
  replace(url: string): void
  /** Subscribe to back/forward; returns the unsubscriber. */
  onPopState(listener: (url: string) => void): () => void
}

export interface RouterService extends RouterHash {
  /** The browsed file; a method because Cordis strips plain fields off services. */
  current(): RelPath | undefined
  readonly file: RelPath | undefined
  /** Open and activate `file` **in content view**; a path outside the mount is refused (`false`). */
  open(file: RelPath): boolean
  /** Close the active tab (no-op without one). */
  close(): void
  getSnapshot(): RouteSnapshot
  subscribe(listener: () => void): () => void
}

const EMPTY: RouteSnapshot = { file: undefined, state: {} }

/** Keys of the hash surface (encoded values, so only the key shape is fixed). */
const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/

/**
 * Decode the path of a URL into a mount-relative path. Returns `undefined` for
 * the root, and `false` for a path that must not be opened (absolute, `..`
 * escapes, NUL) — contract.md §3.8: an invalid path opens nothing.
 */
export function decodeRoute(url: string, mountRoot?: RelPath): RelPath | undefined | false {
  const path = url.split('?')[0]?.split('#')[0] ?? url
  if (!path.startsWith(ROUTE_PREFIX)) return undefined
  const encoded = path.slice(ROUTE_PREFIX.length)
  if (encoded === '') return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return false
  }
  if (decoded.includes('\0') || decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded)) return false
  // Normalise the way a browser does, then refuse anything that leaves the root.
  const segments: string[] = []
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return false
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (segments.length === 0) return undefined
  void mountRoot
  return segments.join('/')
}

/** The hash of a URL, without the `#` ('' when there is none). */
export function hashOf(url: string): string {
  const index = url.indexOf('#')
  return index === -1 ? '' : url.slice(index + 1)
}

/**
 * Decode the hash surface: `#diff=src%2Fapp.js&theme=dark`. Unknown or
 * malformed pairs are ignored (a piece that is no longer in the page must not
 * break the URL another piece wrote).
 */
export function decodeHash(hash: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  for (const pair of body.split('&')) {
    if (pair === '') continue
    const equals = pair.indexOf('=')
    // A bare key is a flag (`#diff`), stored with an empty value.
    if (equals === -1) {
      if (KEY_PATTERN.test(pair)) out[pair] = ''
      continue
    }
    if (equals <= 0) continue
    const key = pair.slice(0, equals)
    if (!KEY_PATTERN.test(key)) continue
    try {
      out[key] = decodeURIComponent(pair.slice(equals + 1))
    } catch {
      // A malformed escape: drop that pair, keep the rest.
    }
  }
  return out
}

/**
 * Encode the hash surface (keys sorted: the same state is the same URL).
 *
 * An empty value is a **flag**: `#diff` means "this file, in diff view". A
 * view that needs parameters writes them as the value (`#diff=HEAD~1`), so the
 * path never has to be repeated in the hash.
 */
export function encodeHash(state: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(state)
    .filter(([key]) => KEY_PATTERN.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => (value === '' ? key : `${key}=${encodeURIComponent(value)}`))
  return pairs.length === 0 ? '' : `#${pairs.join('&')}`
}

/** The active tab's path, from the service (calling is safe across builds). */
function activeTab(tabs: RouterTabs | undefined): { path: RelPath; view?: 'content' | 'diff' } | undefined {
  if (tabs === undefined) return undefined
  return tabs.activeTab !== undefined ? tabs.activeTab() : tabs.active
}

/**
 * The file the page is showing: the active tab's path, whatever its view
 * (contract.md §3.8). A file-related view (a diff, a specific commit's version)
 * is *about* a file, so the file belongs in the path; only view parameters
 * (which view, which commit) go in the hash. A page with no active tab has no
 * file — its pieces' state lives at `/#…`.
 */
function browsedPath(tabs: RouterTabs | undefined): RelPath | undefined {
  return activeTab(tabs)?.path
}

/** Encode a mount path for the URL (`/` stays a separator). */
export function encodeRoute(file: RelPath | undefined): string {
  if (file === undefined || file === '') return '/'
  return ROUTE_PREFIX + file.split('/').map(encodeURIComponent).join('/')
}

export interface RouterOptions {
  history: RouterHistory
  /** The tab service, read lazily (the router activates before `tabs` may). */
  tabs(): RouterTabs | undefined
  /** A file by path (the router opens files it did not get a `FileInfo` for). */
  fileInfo(path: RelPath): FileInfo
  /** Sink for refused paths. */
  warn?(message: string): void
}

/** Build the router over the tab service and the page's history. */
export function createRouterService(options: RouterOptions): RouterService & { dispose(): void; attach(): void } {
  let snapshot: RouteSnapshot = EMPTY
  const listeners = new Set<() => void>()
  const stateListeners = new Map<string, Set<(value: string | undefined) => void>>()
  /** The last path this router wrote, so a tab change it caused is not written twice. */
  let writtenPath: RelPath | undefined
  /** Whether this router has written the path once (the root counts). */
  let pathWritten = false
  /** A deep link seen before `tabs` existed (opened once the service appears). */
  let pending: RelPath | undefined

  const publish = (next: RouteSnapshot): void => {
    if (snapshot.file === next.file && sameState(snapshot.state, next.state)) return
    const previous = snapshot.state
    snapshot = next
    for (const listener of [...listeners]) listener()
    // Pieces hear about the keys they own (a deep link, back/forward, another
    // piece writing the same key).
    for (const [key, set] of stateListeners) {
      if (previous[key] === next.state[key]) continue
      for (const listener of [...set]) listener(next.state[key])
    }
  }

  /** The current URL: the browsed path plus the hash surface. */
  const urlOf = (file: RelPath | undefined, state: Readonly<Record<string, string>>): string =>
    encodeRoute(file) + encodeHash(state)

  const writePath = (file: RelPath | undefined, mode: 'push' | 'replace' = 'push'): void => {
    // Compare paths, not URL strings: the root (`undefined`) also means "we
    // have not written yet", so a first write to the root must still happen.
    if (writtenPath === file && pathWritten) return
    writtenPath = file
    pathWritten = true
    const url = urlOf(file, snapshot.state)
    if (mode === 'replace') options.history.replace(url)
    else options.history.push(url)
  }

  /** A file opened through this router: one history entry, no tab echo. */
  const open = (file: RelPath): boolean => {
    const tabs = options.tabs()
    if (tabs === undefined) {
      // Before the `tabs` piece activates: remember the target and open it as
      // soon as the service exists, so a deep link never depends on boot order.
      pending = file
      return false
    }
    tabs.open(options.fileInfo(file))
    // The subscription (attach) records the path: one writer for `/~/`.
    return true
  }

  const close = (): void => {
    options.tabs()?.close()
  }

  // Tabs changing on their own (tree click, shortcut, close button) move the
  // path: it names the file the page shows, whichever view it shows it in.
  const onTabs = (): void => {
    const path = browsedPath(options.tabs())
    publish({ file: path, state: snapshot.state })
    if (path === undefined) {
      writtenPath = undefined
      pathWritten = false
    }
    writePath(path)
  }

  // Back/forward (or the first pop) moves the path; the hash comes along.
  const onPop = (url: string): void => {
    const nextState = decodeHash(hashOf(url))
    const decoded = decodeRoute(url)
    if (decoded === false) {
      options.warn?.(`[diorama] router: refusing to open ${JSON.stringify(url)} (a path must stay inside the mount)`)
      publish({ file: browsedPath(options.tabs()), state: nextState })
      writePath(browsedPath(options.tabs()), 'replace')
      return
    }
    publish({ file: decoded, state: nextState })
    writtenPath = decoded
    pathWritten = true
    if (decoded === undefined) return
    open(decoded)
  }

  // `attach` runs once `tabs` exists (boot order must not decide deep links).
  let offTabs: (() => void) | undefined
  const attach = (): void => {
    if (offTabs !== undefined) return
    offTabs = options.tabs()?.subscribe(onTabs)
    if (pending !== undefined) {
      const file = pending
      pending = undefined
      open(file)
    }
  }
  attach()
  const offPop = options.history.onPopState(onPop)

  // First load: the URL may already name a file and a piece's state.
  const initialUrl = options.history.read()
  const initial = decodeRoute(initialUrl)
  const initialState = decodeHash(hashOf(initialUrl))
  if (initial === false) {
    options.warn?.(`[diorama] router: ignoring the path in ${JSON.stringify(initialUrl)}`)
    publish({ file: undefined, state: initialState })
  } else if (initial !== undefined) {
    publish({ file: initial, state: initialState })
    writtenPath = initial
    pathWritten = true
    open(initial)
  } else {
    publish({ file: undefined, state: initialState })
  }

  /**
   * Write the hash surface; never a new history entry (contract.md §3.8).
   *
   * The path half comes from the **active tab** at the time of the write, not
   * from `snapshot.file`: after the very first diff tab there is no browsed
   * content tab yet (`snapshot.file` is undefined while the URL is still `/`),
   * and replacing with `/` would silently drop a path the page already shows.
   */
  const writeState = (next: Readonly<Record<string, string>>): void => {
    const file = browsedPath(options.tabs()) ?? snapshot.file
    publish({ file, state: next })
    writtenPath = file
    pathWritten = true
    options.history.replace(urlOf(file, snapshot.state))
  }

  return {
    get file() {
      return snapshot.file
    },
    current: () => snapshot.file,
    open,
    close,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    state(key: string): RouterStateSlot {
      if (!KEY_PATTERN.test(key)) throw new TypeError(`ctx.router.state: ${JSON.stringify(key)} is not a URL-safe key`)
      return {
        get: () => snapshot.state[key],
        set: value => {
          const next = { ...snapshot.state }
          if (value === undefined) delete next[key]
          else next[key] = value // '' is a flag (`#diff`), not a removal
          writeState(next)
        },
        onChange: listener => {
          const set = stateListeners.get(key) ?? new Set()
          set.add(listener)
          stateListeners.set(key, set)
          return () => {
            set.delete(listener)
            if (set.size === 0) stateListeners.delete(key)
          }
        },
      }
    },
    values: () => ({ ...snapshot.state }),
    /** Kernel-internal: the `tabs` piece is up (subscribe, open a queued link). */
    attach,
    dispose() {
      offTabs?.()
      offTabs = undefined
      offPop()
      listeners.clear()
      stateListeners.clear()
    },
  }
}

function sameState(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/** The browser's history, when running in a page. */
export function browserHistory(): RouterHistory | undefined {
  if (typeof window === 'undefined') return undefined
  const current = (): string => `${window.location.pathname}${window.location.search}${window.location.hash}`
  return {
    read: current,
    // The router is the one place that writes the page URL.
    push: url => window.history.pushState(window.history.state, '', url),
    replace: url => window.history.replaceState(window.history.state, '', url),
    onPopState(listener) {
      const handler = (): void => listener(current())
      window.addEventListener('popstate', handler)
      return () => window.removeEventListener('popstate', handler)
    },
  }
}
