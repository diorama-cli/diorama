/**
 * What the reader can do with one file's **bytes** (contract.md §36).
 *
 * All three actions point at the same URL — `/~raw~/<path>` (§4) — and differ
 * only in what the browser is asked to do with it:
 *
 * | action | the URL | the browser |
 * |---|---|---|
 * | download | `?download=1` | saves it (`content-disposition: attachment`) |
 * | copy the link | as it is | nothing: the URL is the answer |
 * | open in a window | as it is | shows it (an image, a PDF) or saves it (a zip) |
 *
 * They are one table because they are one feature seen from three sides: the
 * context menu lists them, the commands run them, and neither should spell the
 * URL itself.
 *
 * **This module imports nothing — not even the kernel.** A new file that
 * imports `diorama-kernel/client` *without* also importing `cordis` drops the
 * `Context.provide` augmentation for the whole package, and the tree's own
 * `ctx.provide('tree', …)` then stops type-checking (docs/m25/spec.md §6,
 * trap 1). The view that owns the mount handle builds the URL; this table only
 * decides what to do with it.
 *
 * The browser bits are injected ({@link FileActionHost}) so the table, the
 * labels and the failure messages are testable without a DOM (`node --test`
 * takes `.ts` only, docs/m15/spec.md §6 trap 2).
 */

/** The three actions, as ids: menu entries, command suffixes, test hooks. */
export type FileActionId = 'download' | 'copyLink' | 'openInWindow'

/** One row of the context menu / one command. */
export interface FileActionSpec {
  id: FileActionId
  /** What the reader reads (menu row, command title). */
  label: string
  /** The second line of the menu row: what it will do, in one clause. */
  hint: string
}

/**
 * The actions in the order the menu lists them: saving first (the one a reader
 * reaches for), then the two that hand the URL over.
 */
export const FILE_ACTIONS: readonly FileActionSpec[] = [
  { id: 'download', label: '下载', hint: '保存这个文件' },
  { id: 'copyLink', label: '复制链接', hint: '复制这个文件的地址' },
  { id: 'openInWindow', label: '独立浏览器窗口打开', hint: '在新窗口里打开或下载' },
]

/** The command id of one action (`file.download`, …). */
export function fileCommand(action: FileActionId): string {
  return `file.${action}`
}

/** What the actions need from the page: three browser calls, nothing else. */
export interface FileActionHost {
  /** Put text on the clipboard; resolves `false` when the browser refused. */
  copy(text: string): Promise<boolean>
  /** Ask for a save of `url`. */
  save(url: string): void
  /** Open `url` in a window of its own; `false` when the browser blocked it. */
  open(url: string): boolean
}

/** The outcome of one action: what to tell the reader, if anything. */
export interface FileActionOutcome {
  ok: boolean
  /** Why it failed, in the reader's words (it carries the URL). */
  message?: string
}

/** The URL one action is handed: the file's bytes, or the same with `?download=1`. */
export function actionUrl(action: FileActionId, url: string): string {
  return action === 'download' ? withDownload(url) : url
}

/**
 * `?download=1` on a URL that may already carry a query. Kept a pure string
 * function so the table never has to know what a mount is.
 */
export function withDownload(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'download=1'
}

/**
 * Run one action on one file URL.
 *
 * Every outcome carries the URL back, which is what makes a refusal
 * recoverable: a clipboard the browser will not write, or a window it blocked,
 * still leaves the reader with the address they asked for.
 */
export async function runFileAction(
  action: FileActionId,
  url: string,
  host: FileActionHost,
): Promise<FileActionOutcome & { url: string }> {
  const target = actionUrl(action, url)
  switch (action) {
    case 'download':
      host.save(target)
      return { ok: true, url: target }
    case 'copyLink': {
      const copied = await host.copy(target)
      return copied
        ? { ok: true, url: target }
        : { ok: false, url: target, message: '浏览器不允许写入剪贴板，请手动复制这个地址：' + target }
    }
    case 'openInWindow': {
      const opened = host.open(target)
      return opened
        ? { ok: true, url: target }
        : { ok: false, url: target, message: '浏览器拦截了新窗口，请允许弹出窗口后重试，或手动打开这个地址：' + target }
    }
  }
}
