/**
 * image — renders image files (contract.md §5.1).
 *
 * The kernel pre-reads text only (v0.6), so this renderer fetches the bytes
 * itself: `stat` first, and when the file is larger than `MAX_BINARY_BYTES` it
 * says so **without** asking for the bytes. Bytes become a Blob URL handed to
 * the browser's own `<img>` — SVG included: an `<img>` renders an SVG without
 * running its scripts (inlining the document would).
 *
 * Matching is `mime: ['image/*']` (contract §5.1 rule 3b), so a new image
 * format enters by adding it to the kernel's mime table, not to this piece.
 */
import type { Context } from 'cordis'
import { useEffect, useState } from 'react'
import type { FileRendererProps, FileInfo } from 'diorama-kernel'
import { MAX_BINARY_BYTES } from 'diorama-kernel/client'
import type {} from 'diorama-plugin-slots'
import { provideEntry } from 'diorama-ui'

export const name = 'image'
export const inject = ['slots']

type State =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'too-large' }
  | { status: 'error'; message: string }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * File → object URL. The key is what identifies the bytes: a re-stat of the
 * same file (same size and mtime) does not fetch again, and a new one loads
 * fresh. `revoke` runs when the key changes or the entry unmounts.
 */
const URLS = new Map<string, string>()

function keyOf(file: FileInfo): string {
  return `${file.path}:${file.size}:${file.mtime}`
}

async function load(props: FileRendererProps): Promise<State> {
  const { file, mountCtx } = props
  // Never request bytes the kernel would refuse (contract §5.1): the check is
  // on the stat we already have, and the answer is a message, not a failure.
  if (file.size > MAX_BINARY_BYTES) return { status: 'too-large' }
  const key = keyOf(file)
  const cached = URLS.get(key)
  if (cached !== undefined) return { status: 'ready', url: cached }
  try {
    const bytes = await mountCtx.fs.readBytes(file.path)
    // Copy into a fresh buffer: the RPC layer may hand back a view.
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: props.mime }))
    URLS.set(key, url)
    return { status: 'ready', url }
  } catch (error) {
    const coded = error as { code?: string; message?: string }
    if (coded.code === 'ETOOLARGE') return { status: 'too-large' }
    return { status: 'error', message: coded.message ?? String(error) }
  }
}

/** Forget the URLs of files this key no longer refers to (path moved on). */
function releaseOthers(path: string, keep: string): void {
  for (const [key, url] of URLS) {
    if (key === keep || !key.startsWith(`${path}:`)) continue
    URL.revokeObjectURL(url)
    URLS.delete(key)
  }
}

export function Image(props: FileRendererProps) {
  const { file, mime } = props
  const key = keyOf(file)
  const [state, setState] = useState<State>(() => {
    const cached = URLS.get(key)
    return cached === undefined ? { status: 'loading' } : { status: 'ready', url: cached }
  })

  useEffect(() => {
    let live = true
    // A new file (or a changed one) starts over; the old URL stays valid until
    // the new read lands so the image does not flash.
    if (URLS.get(key) === undefined) setState({ status: 'loading' })
    void load(props).then(
      next => {
        if (!live) return
        if (next.status === 'ready') releaseOthers(file.path, key)
        setState(next)
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', message: String(error) })
      },
    )
    return () => {
      live = false
    }
  }, [key])

  if (state.status === 'too-large') {
    return (
      <div className="diorama-renderer__empty" role="status" data-testid="image-too-large">
        文件过大，不显示图片（{formatSize(file.size)}，上限 {formatSize(MAX_BINARY_BYTES)}）
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="diorama-renderer__error" role="alert" data-testid="image-error">
        读取图片失败：{state.message}
      </div>
    )
  }
  if (state.status === 'loading') {
    return (
      <div className="diorama-renderer" data-testid="image-loading">
        正在读取 {file.name}…
      </div>
    )
  }
  return (
    <div className="diorama-image" data-testid="image">
      <div className="diorama-image__meta">
        {file.name} · {mime} · {formatSize(file.size)}
      </div>
      <img
        className="diorama-image__img"
        src={state.url}
        alt={file.name}
        title={file.path}
        data-testid="image-img"
        // A byte stream that is not a decodable image (a lying extension):
        // say so instead of showing a broken-image glyph.
        onError={() => setState({ status: 'error', message: '文件内容不是可显示的图片' })}
      />
    </div>
  )
}

export function apply(ctx: Context) {
  provideEntry(
    ctx,
    { id: 'image:renderer', name: 'file.renderer', key: 'image', order: 100, matcher: { mime: ['image/*'] } },
    Image,
  )
}
