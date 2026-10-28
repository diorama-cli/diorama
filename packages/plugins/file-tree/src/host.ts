/**
 * The browser half of the file actions (contract.md §36): clipboard, save, and
 * a window of its own.
 *
 * Kept out of the view so the view is about the tree, and kept here (not in
 * `diorama-ui`) because nothing else needs it yet: a primitive is for rules
 * two pieces must share, and these three are three lines each.
 */
import type { FileActionHost } from './actions.ts'

/**
 * Put `text` on the clipboard.
 *
 * `navigator.clipboard` needs a **secure context**: `127.0.0.1` and
 * `localhost` qualify, but a page opened through a LAN address (`--host
 * 0.0.0.0`, then `http://192.168.x.x`) does not — and there the API is not
 * missing, it is *present and rejects*. So the fallback is a hidden textarea
 * and the old `execCommand`, which still works in that context; if even that
 * fails the caller shows the URL instead of pretending (contract §36).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the textarea: a refusal is not the end of the road.
  }
  return legacyCopy(text)
}

/** The pre-clipboard-API path; returns whether the browser took the text. */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  // Off-screen but focusable: a `display: none` textarea cannot be selected.
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

/**
 * Ask for a save without leaving the page.
 *
 * A navigation to an `attachment` URL makes the browser keep the page and write
 * the file (that is what the header is for), which is why no `<a download>` is
 * needed: the response decides.
 */
export function saveUrl(url: string): void {
  window.location.assign(url)
}

/**
 * Open the URL in a **new tab**, not a separate window.
 *
 * The action is called 「独立浏览器窗口打开」 because that is what it means to a
 * reader — "show me this file outside diorama" — but the browser decides the
 * chrome: `window.open(url, '_blank')` with no window features is a tab in every
 * modern browser, which is what a reader expects from a link. Asking for
 * `popup=yes` (the first version) forces a real OS window with no toolbar, no
 * tab strip and no address bar — and an address bar is exactly what one wants
 * when the point is "give me this file's URL".
 *
 * A blocked popup answers `null`; the caller then says so (with the URL) rather
 * than silently doing nothing.
 */
export function openInWindow(url: string): boolean {
  const opened = window.open(url, '_blank')
  return opened !== null && opened !== undefined
}

/** The host this page uses (the URL is built by the caller, see `actions.ts`). */
export function browserFileActionHost(): FileActionHost {
  return { copy: copyText, save: saveUrl, open: openInWindow }
}
