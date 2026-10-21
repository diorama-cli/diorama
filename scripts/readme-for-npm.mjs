#!/usr/bin/env node
/**
 * The README npm shows is a *rendered page on npmjs.com*, not a file next to
 * the code: every relative link in it resolves against
 * `https://www.npmjs.com/package/<name>/…`, where `docs/contract.md` and
 * `docs/m7/tree.png` do not exist. So the published copy points at the
 * repository instead (docs/m8/spec.md §3).
 *
 * This module is pure so the rewrite can be tested without running the
 * assembler: `packages/cli/test/npm-readme.test.ts`.
 */

const FENCE = /^\s*(?:```|~~~)/

/** `[label](target "title")` / `![alt](target)`; `target` may be `<wrapped>`. */
const LINK = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)([^)]*)\)/g

/** Schemes and roots that are already absolute: leave them exactly as they are. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i

/**
 * `git+https://github.com/owner/repo.git` → the two bases GitHub serves files
 * from. Images need `raw.` (a `blob/` URL answers with an HTML page, which an
 * `<img>` cannot render); everything else reads better in the `blob/` viewer.
 */
export function baseUrls({ repositoryUrl, branch = 'main' }) {
  const base = repositoryUrl
    .replace(/^git\+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  const parsed = new URL(base)
  if (parsed.hostname !== 'github.com') {
    throw new Error(`readme-for-npm: unsupported repository host "${parsed.hostname}" (only github.com)`)
  }
  const path = parsed.pathname.replace(/^\/|\/$/g, '')
  if (!path.includes('/')) throw new Error(`readme-for-npm: "${repositoryUrl}" is not a repository URL`)
  const [owner, repo] = path.split('/')
  return {
    blob: `${base}/blob/${branch}/`,
    raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`,
  }
}

/** Rewrite one link target, keeping its fragment/query and any title. */
function rewriteTarget(target, { blob, raw, image }) {
  if (target === '' || ABSOLUTE.test(target)) return target
  const path = target.replace(/^\.\//, '')
  return (image ? raw : blob) + path
}

/**
 * Rewrite every *relative* Markdown link and image in `markdown` to the
 * repository URL. Fenced code blocks are skipped: a path inside a sample
 * command is content, not a link. Raw HTML `src`/`href` is not rewritten —
 * this README uses Markdown image syntax — so `unresolvedLinks()` reports a
 * relative one and the assembler fails instead of publishing a broken link.
 */
export function rewriteReadme(markdown, options) {
  const urls = baseUrls(options)
  let inFence = false
  return markdown
    .split('\n')
    .map(line => {
      if (FENCE.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(LINK, (match, bang, label, target, rest) => {
        const wrapped = target.startsWith('<')
        const path = wrapped ? target.slice(1, -1) : target
        const next = rewriteTarget(path, { ...urls, image: bang === '!' })
        return `${bang}[${label}](${wrapped ? `<${next}>` : next}${rest})`
      })
    })
    .join('\n')
}

/** `src="…"` / `href="…"` in raw HTML, which Markdown also passes through. */
const HTML_ATTR = /\b(?:src|href)\s*=\s*(["'])([^"']*)\1/g

/**
 * Relative Markdown links still left after a rewrite — the assembler treats a
 * non-empty result as a bug (a link form the rewrite does not know about).
 * Raw-HTML `src`/`href` are reported too: the rewrite only knows Markdown
 * syntax, so a relative path there has to fail loudly rather than ship broken.
 */
export function unresolvedLinks(markdown) {
  const found = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    for (const match of line.matchAll(LINK)) {
      const target = match[3].startsWith('<') ? match[3].slice(1, -1) : match[3]
      if (target !== '' && !ABSOLUTE.test(target)) found.push(target)
    }
    for (const match of line.matchAll(HTML_ATTR)) {
      const target = match[2]
      if (target !== '' && !ABSOLUTE.test(target)) found.push(target)
    }
  }
  return found
}
