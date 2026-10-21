#!/usr/bin/env node
/**
 * One release, in one command (docs/release.md).
 *
 * `pnpm release <version>` does the *local* half of a release: it moves every
 * version number in the repository to the new value, verifies the result,
 * commits and tags. It never publishes. The tag is what publishes — pushing it
 * triggers `.github/workflows/release.yml`, which publishes the tarball with
 * npm trusted publishing (OIDC), so no npm token lives in this repository or
 * on a maintainer's machine.
 *
 * Why a script and not `npm version`: a release here is not one number.
 *
 * | what | where | why it has to move |
 * |---|---|---|
 * | the published version | `packages/cli/package.json` | the only public package |
 * | the 19 internal versions | `packages/**` | they ship inside the bundle; one number reads better than 19 |
 * | the contract version | `kernel/src/contract.ts` | contract.md §6: it moves *at* a release |
 * | the 17 contract ranges | every `diorama.contract` | a stale range makes the new kernel refuse its own pieces |
 * | the docs quoting the number | contract.md, features.md, AGENTS.md, README.md | people read them, and the README ships to npm |
 *
 * Missing any one is silent: the tarball still builds, and the failure only
 * surfaces as "plugin refused to load" or a stale number on npmjs.com.
 *
 * Everything here is pure; `main()` lives in `cli.mjs` and is handed its IO, so
 * the whole plan is testable without a repository.
 */

/** The one package that is published; everything else is private and inlined. */
export const PUBLIC_PACKAGE = 'packages/cli'

/** The page shell. Never published, so its `0.0.0` is not part of a release. */
export const UNVERSIONED_PACKAGE = 'apps/web'

const VERSION = /^\d+\.\d+\.\d+$/

/** Manifests a release touches: `packages/**`, plus `apps/**` for the contract field. */
export function packageManifests(files) {
  return files
    .filter(file => file.endsWith('/package.json'))
    // Assembled copies (scripts/assemble-package.mjs) — derived, never edited.
    .filter(file => !file.startsWith(`${PUBLIC_PACKAGE}/plugins/`))
    .sort()
}

/** `0.0.3` (or `v0.0.3`) → `0.0.3`; anything else is an error, not a guess. */
export function parseVersion(input) {
  const raw = String(input ?? '').trim().replace(/^v/, '')
  if (!VERSION.test(raw)) {
    throw new Error(`"${input}" is not a version — write it as 0.0.3 (no suffix: a prerelease keeps \`npm i -g\` off it)`)
  }
  return raw
}

/** `0.0.2` → `0.0.3`: the pre-1.0 line only moves its last number (docs/m8/spec.md §1). */
export function nextVersion(current) {
  const [major, minor, patch] = parseVersion(current).split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

/**
 * The range every built-in piece declares for a kernel at `version`.
 *
 * The upper bound is the next *breaking* line, which on `0.0.x` is the next
 * minor: `0.0.3` → `>=0.0.3 <0.1.0`. Pre-1.0, a minor bump is the breaking
 * one, so `<1.0.0` would silently accept an incompatible kernel.
 */
export function contractRange(version) {
  const [major, minor] = parseVersion(version).split('.').map(Number)
  const upper = major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`
  return `>=${version} <${upper}`
}

/** The current published version, read from the one manifest that is published. */
export function currentVersion(files) {
  const manifest = files[`${PUBLIC_PACKAGE}/package.json`]
  if (manifest === undefined) throw new Error(`${PUBLIC_PACKAGE}/package.json is missing`)
  return parseVersion(JSON.parse(manifest).version)
}

/**
 * Docs quote the number in prose, so each edit is anchored on the sentence that
 * carries it — a blanket search-and-replace would also rewrite the changelog
 * tables, which are a record of *past* versions and must stay as written.
 *
 * `$V` is the new version, `$R` its contract range.
 */
const DOC_EDITS = {
  'docs/contract.md': [
    [/^(# 插件契约 )v\d+\.\d+\.\d+$/m, '$1v$V'],
    // These sit mid-line (a sentence continues after the number), so none of
    // them can be anchored to end-of-line.
    [/(\*\*状态：)v\d+\.\d+\.\d+( 已定稿。\*\*)/, '$1v$V$2'],
    [/(内核契约版本 `)\d+\.\d+\.\d+(`)/, '$1$V$2'],
    [/(所有插件声明 `contract: ")[^"]*("`)/, '$1$R$2'],
    [/(插件写窄范围（当前 `)[^`]*(`）)/, '$1$R$2'],
    [/(当前范围（`)\d+\.\d+\.\d+(` 起为 `)[^`]*(`）)/, '$1$V$2$R$3'],
    // §1's manifest sample: the range a new plugin should copy.
    [/("contract": ")[^"]*(")/, '$1$R$2'],
  ],
  'docs/features.md': [[/(> 契约见 \[contract\.md\]\(contract\.md\) \*\*)v\d+\.\d+\.\d+(\*\*)/, '$1v$V$2']],
  'AGENTS.md': [
    [/(> 当前契约 \*\*)v\d+\.\d+\.\d+(\*\*)/, '$1v$V$2'],
    // A table row, not a blockquote: the version sits mid-cell, after
    // `**能不能**：内核与插件的唯一约定，带版本号（当前 **v0.0.2**）`.
    [/(内核与插件的唯一约定，带版本号（当前 \*\*)v\d+\.\d+\.\d+(\*\*）)/, '$1v$V$2'],
    [/(`contract: ")[^"]*("`)/, '$1$R$2'],
  ],
  'README.md': [
    [/(兼容的契约版本范围（当前 `)[^`]*(`）)/, '$1$R$2'],
    [/^(- 契约版本 `)\d+\.\d+\.\d+(`)/m, '$1$V$2'],
    // `插件声明 `>=0.0.2 <0.1.0`）。` — the backtick is followed by a full-width
    // stop, not by `)`.
    [/(插件声明 `)[^`]*(`)/, '$1$R$2'],
  ],
}

/** Apply the anchored doc edits, reporting whether anything actually changed. */
export function rewriteDocs(path, source, version) {
  const replacements = { $V: version, $R: contractRange(version) }
  const expand = text => text.replace(/\$[VR]/g, token => replacements[token])
  let after = source
  for (const [pattern, replacement] of DOC_EDITS[path] ?? []) {
    after = after.replace(pattern, expand(replacement))
  }
  return after
}

/**
 * Every file edit a release needs, computed from the files as they are.
 * Returns `[{ path, before, after, why }]`; the caller writes them.
 *
 * A file already at the target version produces no edit, so re-running a
 * half-finished release is safe and idempotent.
 */
export function releaseEdits({ files, version }) {
  const next = parseVersion(version)
  const edits = []
  const push = (path, before, after, why) => {
    if (before !== after) edits.push({ path, before, after, why })
  }

  for (const path of packageManifests(Object.keys(files))) {
    const source = files[path]
    const parsed = JSON.parse(source)
    const bumped = { ...parsed }
    if (path !== `${UNVERSIONED_PACKAGE}/package.json` && parsed.version !== undefined) {
      bumped.version = next
    }
    if (parsed.diorama?.contract !== undefined) {
      bumped.diorama = { ...parsed.diorama, contract: contractRange(next) }
    }
    // Re-serialised the way the repository writes manifests (2 spaces, final
    // newline); `JSON.stringify` round-trips every one of them byte-for-byte.
    push(path, source, `${JSON.stringify(bumped, null, 2)}\n`, 'version')
  }

  const contractPath = 'packages/kernel/src/contract.ts'
  const contract = files[contractPath]
  if (contract !== undefined) {
    const after = contract
      .replace(/(export const CONTRACT_VERSION = ')[^']*(')/, `$1${next}$2`)
      .replace(/(export const CONTRACT_RANGE = ')[^']*(')/, `$1${contractRange(next)}$2`)
      // The doc comment above the constants quotes the range in prose.
      .replace(/(\* \(`)[^`]*(`\), so a published kernel never loads a piece built against)/, `$1${contractRange(next)}$2`)
    push(contractPath, contract, after, 'contract version')
  }

  for (const path of Object.keys(DOC_EDITS)) {
    const source = files[path]
    if (source !== undefined) push(path, source, rewriteDocs(path, source, next), 'docs quoting the version')
  }

  return edits
}

/**
 * Refuse a tarball that is missing something npm needs. These are exactly the
 * failures docs/m8/spec.md §5 records — each was silent until install.
 */
export function verifyTarball({ files, version, contract, publicManifest }) {
  const problems = []
  for (const required of ['README.md', 'LICENSE', 'package.json', 'bin/diorama', 'web/index.html']) {
    if (!files.includes(required)) problems.push(`tarball is missing ${required}`)
  }
  if (!files.some(file => /^plugins\/[^/]+\/package\.json$/.test(file))) {
    problems.push('tarball is missing plugins/<id>/package.json (the boot graph reads them)')
  }
  if (!files.some(file => /^plugins\/[^/]+\/lib\/client\.cjs$/.test(file))) {
    problems.push('tarball is missing plugins/<id>/lib/client.cjs (the browser loads them)')
  }
  if (publicManifest.version !== version) {
    problems.push(`package.json says ${publicManifest.version}, the tag says ${version}`)
  }
  if (contract !== version) problems.push(`CONTRACT_VERSION is ${contract}, the tag says ${version}`)
  // Internal packages are inlined by tsdown (`deps.alwaysBundle`); a leftover
  // workspace dependency would make `npm i` look for packages nobody published.
  for (const [name, range] of Object.entries(publicManifest.dependencies ?? {})) {
    if (name.startsWith('diorama-') || String(range).startsWith('workspace:')) {
      problems.push(`published dependencies must be third-party only: ${name}@${range}`)
    }
  }
  return problems
}
