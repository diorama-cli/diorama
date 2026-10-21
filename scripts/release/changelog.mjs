#!/usr/bin/env node
/**
 * CHANGELOG.md, generated from the commit subjects since the previous tag.
 *
 * A release note written by hand drifts from what shipped; the commit log does
 * not. Conventional-commit types become sections, and a subject that does not
 * parse goes under "Other" rather than being dropped — a release note that
 * silently loses a commit is worse than an untidy one.
 *
 * Pure, so `packages/cli/test/release.test.ts` can pin the shape.
 */

const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['test', 'Tests'],
  ['build', 'Build'],
  ['ci', 'CI'],
  ['chore', 'Chores'],
]

/** The changelog's preamble: written once, then kept by `insertChangelog`. */
export const PREAMBLE = `# Changelog

Every published version of \`@diorama-cli/diorama\`, newest first. Generated from
the commit log by \`pnpm release\` — see [docs/release.md](docs/release.md).
`

/** One release section: `## 0.0.3 (2026-10-21)` plus its grouped commits. */
export function changelogEntry({ version, date, commits }) {
  const buckets = new Map(SECTIONS.map(([type]) => [type, []]))
  const other = []
  for (const subject of commits) {
    const line = String(subject).trim()
    if (line === '') continue
    const match = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(line)
    if (match === null) {
      other.push(line)
      continue
    }
    const [, type, scope, text] = match
    const entry = scope === undefined ? text : `**${scope}:** ${text}`
    if (buckets.has(type)) buckets.get(type).push(entry)
    else other.push(entry)
  }

  const lines = [`## ${version} (${date})`, '']
  for (const [type, title] of SECTIONS) {
    const items = buckets.get(type)
    if (items === undefined || items.length === 0) continue
    lines.push(`### ${title}`, '', ...items.map(item => `- ${item}`), '')
  }
  if (other.length > 0) lines.push('### Other', '', ...other.map(item => `- ${item}`), '')
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * Put a new entry directly under the preamble, so the newest release is the
 * first thing a reader sees. An empty or missing file gets the preamble too.
 */
export function insertChangelog(existing, entry) {
  if (existing === undefined || existing.trim() === '') return `${PREAMBLE}\n${entry}`
  const first = /\n## /.exec(existing)
  if (first === null) return `${existing.replace(/\n*$/, '')}\n\n${entry}`
  const at = first.index + 1
  return `${existing.slice(0, at)}${entry}\n${existing.slice(at)}`
}
