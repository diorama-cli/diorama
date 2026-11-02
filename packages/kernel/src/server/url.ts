/**
 * Turning a bind address into a URL (contract.md §7.3, §7.7).
 *
 * Two facts drive this module:
 *
 * - A wildcard bind (`0.0.0.0` / `::`) is **not an address**: `http://0.0.0.0:7777/`
 *   is not something a browser opens, so a wildcard always shows as loopback.
 * - An IPv6 literal needs brackets (`http://[::1]:7777/`), and only a bracketed
 *   value can be split from its port.
 *
 * It lives in its own module because both the mount table (`gateway.ts`) and the
 * index page (`index-page.ts`) build URLs, and the page must not import the
 * table it is rendered from.
 */

/** Whether `host` means "every interface" rather than one address. */
export function isWildcardHost(host: string): boolean {
  const value = host.trim()
  return value === '0.0.0.0' || value === '::' || value === '::0' || value === '[::]'
}

/** Whether `host` is this machine only. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().replace(/^\[(.*)\]$/, '$1')
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
}

/** The address to show for a bind address: a wildcard is every interface, so it shows as loopback. */
export function displayHost(host: string): string {
  return isWildcardHost(host) ? '127.0.0.1' : host.trim()
}

/** `http://host:port/` with IPv6 brackets. */
export function mountUrl(host: string, port: number): string {
  const shown = displayHost(host)
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}/`
}

/**
 * The host part of a `Host` header (`example.test:7777`, `[::1]:7777`, `::1`),
 * or `undefined` when the header says nothing usable.
 *
 * The page needs it because a wildcard bind has no address of its own: the
 * request that reached it is the only thing that knows which name worked.
 */
export function requestHostname(hostHeader: string | undefined): string | undefined {
  const value = hostHeader?.trim()
  if (value === undefined || value === '') return undefined
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracketed !== null) return bracketed[1]
  // A bare IPv6 literal has several colons and no port to strip.
  const first = value.indexOf(':')
  if (first === -1) return value
  if (first !== value.lastIndexOf(':')) return value
  const port = value.slice(first + 1)
  return /^\d+$/.test(port) ? value.slice(0, first) : value
}
