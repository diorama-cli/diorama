/**
 * pdf — renders PDF files (contract.md §5.1, v0.6).
 *
 * Like `image`, the kernel pre-reads text only, so this renderer fetches the
 * bytes itself after a `stat` and refuses to ask for a file over
 * `MAX_BINARY_BYTES`. The bytes become a blob URL in a `<iframe>`: the
 * browser's own PDF viewer draws it, which keeps a PDF engine out of the
 * bundle. Where the viewer is unavailable (some browsers, embedded webviews)
 * the frame stays blank, so the header always offers the blob itself as a
 * link — a reader can still open or save the file.
 *
 * Matching is `ext: ['pdf']`: `.pdf` is unambiguous, and the ext tier is ahead
 * of `mime` (contract §5.1 rule 2), so nothing else needs to claim it.
 */
import type { Context } from 'cordis'
import { useEffect, useState } from 'react'
import type { FileInfo, FileRendererProps } from 'diorama-kernel'
import { MAX_BINARY_BYTES } from 'diorama-kernel/client'
import type {} from 'diorama-plugin-slots'
import { FileIcon, Icon, provideEntry } from 'diorama-ui'

export const name = 'pdf'
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

/** Blob URLs by file identity, so a re-stat of the same file does not re-read. */
const URLS = new Map<string, string>()

function keyOf(file: FileInfo): string {
  return `${file.path}:${file.size}:${file.mtime}`
}

async function load(props: FileRendererProps): Promise<State> {
  const { file, mountCtx } = props
  if (file.size > MAX_BINARY_BYTES) return { status: 'too-large' }
  const key = keyOf(file)
  const cached = URLS.get(key)
  if (cached !== undefined) return { status: 'ready', url: cached }
  try {
    const bytes = await mountCtx.fs.readBytes(file.path)
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
    URLS.set(key, url)
    return { status: 'ready', url }
  } catch (error) {
    const coded = error as { code?: string; message?: string }
    if (coded.code === 'ETOOLARGE') return { status: 'too-large' }
    return { status: 'error', message: coded.message ?? String(error) }
  }
}

function releaseOthers(path: string, keep: string): void {
  for (const [key, url] of URLS) {
    if (key === keep || !key.startsWith(`${path}:`)) continue
    URL.revokeObjectURL(url)
    URLS.delete(key)
  }
}

export function Pdf(props: FileRendererProps) {
  const { file } = props
  const key = keyOf(file)
  const [state, setState] = useState<State>(() => {
    const cached = URLS.get(key)
    return cached === undefined ? { status: 'loading' } : { status: 'ready', url: cached }
  })

  useEffect(() => {
    let live = true
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
      <div className="diorama-renderer__empty" role="status" data-testid="pdf-too-large">
        文件过大，不显示 PDF（{formatSize(file.size)}，上限 {formatSize(MAX_BINARY_BYTES)}）
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="diorama-renderer__error" role="alert" data-testid="pdf-error">
        读取 PDF 失败：{state.message}
      </div>
    )
  }
  if (state.status === 'loading') {
    return (
      <div className="diorama-renderer" data-testid="pdf-loading">
        正在读取 {file.name}…
      </div>
    )
  }
  return (
    <div className="diorama-pdf" data-testid="pdf">
      <div className="diorama-pdf__meta">
        <span>
          <FileIcon name={file.name} />
          {file.name} · application/pdf · {formatSize(file.size)}
        </span>
        {/* The viewer may be unavailable (it is the browser's): the blob is
            always reachable, so the file is never a dead end. */}
        <a className="diorama-pdf__open" href={state.url} target="_blank" rel="noreferrer" data-testid="pdf-open">
          <Icon name="external-link" size={14} />
          在新标签打开
        </a>
      </div>
      <iframe className="diorama-pdf__frame" src={state.url} title={file.path} data-testid="pdf-frame" />
    </div>
  )
}

export function apply(ctx: Context) {
  provideEntry(ctx, { id: 'pdf:renderer', name: 'file.renderer', key: 'pdf', order: 110, matcher: { ext: ['pdf'] } }, Pdf)
}
