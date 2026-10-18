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
import type { FileRendererProps } from 'diorama-kernel'

export const name = 'plaintext'
export const inject = ['slots']

/** How a binary file is described in the fallback (no mojibake). */
function describeBinary(bytes: Uint8Array, mime: string): string {
  return `二进制文件，无法以文本显示（${mime}，${bytes.length} 字节）`
}

function Plaintext({ file, text, bytes, mime }: FileRendererProps) {
  return (
    <div className="diorama-plaintext-wrap" data-testid="plaintext">
      <div className="diorama-plaintext__path">{file.path}</div>
      {text !== undefined ? (
        <pre className="diorama-plaintext" data-path={file.path}>
          {text}
        </pre>
      ) : (
        <div className="diorama-renderer__empty" role="status" data-testid="plaintext-binary">
          {describeBinary(bytes ?? new Uint8Array(), mime)}
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
