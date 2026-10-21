#!/usr/bin/env node
/**
 * The gate a release has to pass, run by `pnpm release` before it commits and
 * by `.github/workflows/release.yml` before it publishes. One implementation,
 * so the two can never disagree about what "releasable" means.
 *
 * Checks, in the order that makes a failure easiest to read:
 *
 *   1. every version in the repository agrees with the tag being released
 *   2. the tag points at the commit being published (CI only)
 *   3. the assembled tarball carries everything npm needs, and nothing it must not
 *
 * Usage: `node scripts/release/verify.mjs [--tag v0.0.3] [--tarball path.tgz]`
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contractRange, parseVersion, verifyTarball } from './plan.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Every workspace manifest, as `{ path, parsed }`, in a stable order. */
export function manifests(root = repo) {
  const paths = []
  for (const dir of ['packages', 'apps']) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, dir, entry.name, 'package.json'))) {
        paths.push(`${dir}/${entry.name}/package.json`)
      }
    }
  }
  for (const entry of readdirSync(join(root, 'packages/plugins'), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(root, 'packages/plugins', entry.name, 'package.json'))) {
      paths.push(`packages/plugins/${entry.name}/package.json`)
    }
  }
  return paths.sort().map(path => ({ path, parsed: JSON.parse(readFileSync(join(root, path), 'utf8')) }))
}

/**
 * `CONTRACT_VERSION` as the kernel actually declares it. Read as text rather
 * than imported: this script runs under plain `node`, and the constant lives in
 * a `.ts` module.
 */
export function contractVersion(root = repo) {
  const source = readFileSync(join(root, 'packages/kernel/src/contract.ts'), 'utf8')
  const match = /export const CONTRACT_VERSION = '([^']+)'/.exec(source)
  if (match === null) throw new Error('contract.ts declares no CONTRACT_VERSION')
  return match[1]
}

/**
 * The consistency checks that need no tarball: every manifest moved together,
 * and the contract moved with them.
 */
export function versionProblems({ version, contract, entries }) {
  const problems = []
  const range = contractRange(version)
  for (const { path, parsed } of entries) {
    // The page shell is never published; its `0.0.0` is not a release number.
    if (path === 'apps/web/package.json') continue
    if (parsed.version !== version) {
      problems.push(`${path}: version is ${parsed.version}, expected ${version}`)
    }
    if (parsed.diorama?.contract !== undefined && parsed.diorama.contract !== range) {
      problems.push(`${path}: contract is "${parsed.diorama.contract}", expected "${range}"`)
    }
  }
  if (contract !== version) problems.push(`CONTRACT_VERSION is ${contract}, expected ${version}`)
  return problems
}

/** The file list inside a tarball, as npm would see it (`package/` stripped). */
export function tarballFiles(tarball) {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .map(entry => entry.replace(/^package\//, '').replace(/\/$/, ''))
    .filter(entry => entry !== '')
}

/** Everything the release gate knows, as a list of human-readable problems. */
export function releaseProblems({ root = repo, tag, tarball, run = execFileSync }) {
  const entries = manifests(root)
  const published = entries.find(entry => entry.path === 'packages/cli/package.json')
  if (published === undefined) return ['packages/cli/package.json is missing']
  const version = parseVersion(tag === undefined ? published.parsed.version : String(tag).replace(/^v/, ''))
  const contract = contractVersion(root)
  const problems = versionProblems({ version, contract, entries })

  if (tag !== undefined) {
    // `rev-list` on a tag that does not exist prints to stderr and throws;
    // catch it and report it as a problem rather than as a crash.
    try {
      const head = run('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      const tagged = run('git', ['rev-list', '-n', '1', tag], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (head !== tagged) problems.push(`${tag} does not point at HEAD (${tagged.slice(0, 7)} vs ${head.slice(0, 7)})`)
    } catch {
      problems.push(`${tag} is not a tag in this repository`)
    }
  }

  if (tarball !== undefined) {
    if (!existsSync(tarball)) {
      problems.push(`${tarball} does not exist — run "pnpm pack:prepare" first`)
    } else {
      const publicManifest = JSON.parse(
        run('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
      )
      problems.push(...verifyTarball({ files: tarballFiles(tarball), version, contract, publicManifest }))
    }
  }
  return problems
}

function main(argv) {
  const tagIndex = argv.indexOf('--tag')
  const tarballIndex = argv.indexOf('--tarball')
  const problems = releaseProblems({
    tag: tagIndex === -1 ? undefined : argv[tagIndex + 1],
    tarball: tarballIndex === -1 ? undefined : argv[tarballIndex + 1],
  })
  if (problems.length > 0) {
    process.stderr.write(`release:verify — ${problems.length} problem(s):\n`)
    for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`)
    return 1
  }
  const tagIndex2 = argv.indexOf('--tag')
  const version = tagIndex2 === -1 ? 'the working tree' : argv[tagIndex2 + 1]
  process.stdout.write(`✓ release:verify — ${version} is consistent\n`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
