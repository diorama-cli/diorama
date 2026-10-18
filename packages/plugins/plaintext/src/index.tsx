/**
 * plaintext — the fallback renderer.
 *
 * Contract.md §5.1: plaintext is the `order: Infinity` entry that does not
 * participate in matching. M0 has no matcher tier yet, so this piece simply
 * registers the last renderer in the list: raw text, monospace, no
 * highlighting and no Markdown (plan.md M0 demo).
 */
import type { Context } from 'cordis'
import type {} from 'diorama-plugin-slots'
import type { FileRendererProps } from 'diorama-plugin-renderer-registry/types'

export const name = 'plaintext'
export const inject = ['slots']

function Plaintext({ file, content }: FileRendererProps) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(content)
  return (
    <div className="diorama-plaintext-wrap" data-testid="plaintext">
      <div className="diorama-plaintext__path">{file.path}</div>
      <pre className="diorama-plaintext" data-path={file.path}>
        {text}
      </pre>
    </div>
  )
}

export function apply(ctx: Context) {
  ctx.slots.register({ id: 'plaintext:fallback', name: 'file.renderer', order: Number.POSITIVE_INFINITY }, Plaintext)
}
