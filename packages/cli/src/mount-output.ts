/**
 * The two shapes `diorama <dir>` can print (contract.md §7.6): the human block
 * and the one-JSON-document form (`--json`).
 *
 * A separate module because both the short-lived path (`main.ts`) and the
 * foreground path (`run.ts`) print a mount, and because the JSON shape is a
 * contract for other programs: it must not drift between the two callers.
 */
import type { MountStatus } from 'diorama-kernel/server'

/** What a caller prints: the mount plus the two facts the lines carry. */
export interface MountOutput {
  /** The mount the gateway reports (contract.md §7.3). */
  mount: MountStatus
  /** `true` when this call mounted the directory, `false` when it already was. */
  created: boolean
  /** Plugin failures the server reported while booting (exit code 1 when set). */
  pluginFailures?: string
}

/**
 * The five lines `diorama <dir>` prints (contract.md §7.6).
 *
 * `already mounted` is an extra line when the mount already existed; the
 * `hidden:` line only appears when the ignore rules are not empty.
 */
export function mountLines(output: MountOutput, name = 'diorama'): string[] {
  const { mount } = output
  const lines = [
    `${name} serving ${mount.root}`,
    `  ${mount.url}`,
    `  config: ${mount.configFile ?? 'none (defaults)'}`,
    `  [mount:${mount.mountId}] plugins: ${mount.plugins.join(', ') || '(none)'}`,
  ]
  if (mount.hidden.length > 0) lines.push(`  hidden: ${mount.hidden.join(', ')}`)
  if (!output.created) lines.push(`already mounted (run "${name} restart <dir>" to reload)`)
  return lines
}

/**
 * The `--json` document: **one** JSON object per invocation, on stdout.
 *
 * Keys are stable (other programs read them): `mount` is the control plane's
 * `MountStatus` verbatim, `created` says whether this call mounted it, and
 * `pluginFailures` is present only when the server reported failures.
 */
export function mountDocument(output: MountOutput): Record<string, unknown> {
  const document: Record<string, unknown> = {
    mount: output.mount,
    // The one field callers always want: where to point a browser.
    url: output.mount.url,
    root: output.mount.root,
    mountId: output.mount.mountId,
    created: output.created,
  }
  if (output.pluginFailures !== undefined) document.pluginFailures = output.pluginFailures
  return document
}
