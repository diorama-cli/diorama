/**
 * plaintext — the fallback renderer.
 *
 * Contract.md §5.1: `plaintext` is the entry **without a matcher**. It is not
 * tried in the `ext` / `mime` / `probe` scan; it renders whatever no other
 * renderer claimed, and takes over when a matched renderer fails. Raw text,
 * monospace, no highlighting and no Markdown.
 */
import type { Context } from 'cordis'
import type {} from 'diorama-plugin-slots'
import { provideEntry } from 'diorama-ui'
import type { FileInfo, FileRendererProps } from 'diorama-kernel'

export const name = 'plaintext'
export const inject = ['slots']

/**
 * How a file with no text is described in the fallback (no mojibake). The
 * kernel pre-reads text only (contract.md §5.1 v0.6), so the size comes from
 * the `stat` the registry already made — the fallback never reads bytes.
 */
function describeBinary(file: FileInfo, mime: string): string {
  return `二进制文件，无法以文本显示（${mime}，${formatSize(file.size)}）`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function Plaintext({ file, text, mime }: FileRendererProps) {
  return (
    <div className="diorama-plaintext-wrap" data-testid="plaintext">
      <div className="diorama-plaintext__path">{file.path}</div>
      {text !== undefined ? (
        <pre className="diorama-plaintext" data-path={file.path}>
          {text}
        </pre>
      ) : (
        <div className="diorama-renderer__empty" role="status" data-testid="plaintext-binary">
          {describeBinary(file, mime)}
        </div>
      )}
    </div>
  )
}

export function apply(ctx: Context) {
  provideEntry(ctx, { id: 'plaintext:fallback', name: 'file.renderer', key: 'plaintext', order: 1_000_000 },
    Plaintext,
  )
}
