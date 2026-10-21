#!/usr/bin/env node
/**
 * `pnpm release <version>` — the local half of a release (docs/release.md).
 *
 * Steps, in order, each one refusing to continue on the previous one's doubt:
 *
 *   1. read every manifest and the contract, compute the edits
 *   2. write them (and the changelog entry) — nothing else is touched
 *   3. run the four verification commands from AGENTS.md §3
 *   4. `git add` + `git commit` + annotated `git tag`
 *
 * It never pushes and never publishes. `--dry-run` stops after step 1.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelogEntry, insertChangelog } from './changelog.mjs'
import { currentVersion, nextVersion, parseVersion, releaseEdits } from './plan.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const USAGE = `pnpm release <version> [--dry-run] [--no-verify]

  <version>    the version to release, e.g. 0.0.3 (or "next" for the next 0.0.x)
  --dry-run    print the edits and stop
  --no-verify  skip build/test/typecheck (only when you just ran them)
`

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', ...options }).trim()
}

function sh(command, args, label) {
  process.stdout.write(`▸ ${label}\n`)
  execFileSync(command, args, { cwd: repo, stdio: 'inherit' })
}

/** Every manifest the plan looks at, plus the files the plan edits. */
function readFiles() {
  const files = {}
  const manifests = ['package.json']
  for (const dir of ['packages', 'apps']) {
    for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(repo, dir, entry.name, 'package.json'))) {
        manifests.push(`${dir}/${entry.name}/package.json`)
      }
    }
  }
  for (const entry of readdirSync(join(repo, 'packages/plugins'), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(repo, 'packages/plugins', entry.name, 'package.json'))) {
      manifests.push(`packages/plugins/${entry.name}/package.json`)
    }
  }
  for (const path of manifests) files[path] = readFileSync(join(repo, path), 'utf8')

  for (const path of [
    'packages/kernel/src/contract.ts',
    'docs/contract.md',
    'docs/features.md',
    'AGENTS.md',
    'README.md',
  ]) {
    if (existsSync(join(repo, path))) files[path] = readFileSync(join(repo, path), 'utf8')
  }
  return files
}

function main(argv) {
  const dryRun = argv.includes('--dry-run')
  const verify = !argv.includes('--no-verify')
  const target = argv.find(arg => !arg.startsWith('--'))
  if (target === undefined || target === '-h' || target === '--help') {
    process.stdout.write(USAGE)
    return target === undefined ? 2 : 0
  }

  // A release starts from a clean tree: a stray edit would be committed as part
  // of it, and `git tag` would point at a commit nobody reviewed.
  const dirty = git(['status', '--porcelain'])
  if (dirty !== '') {
    process.stderr.write(`release: the working tree is not clean — commit or stash first:\n${dirty}\n`)
    return 1
  }

  const files = readFiles()
  const from = currentVersion(files)
  const version = target === 'next' ? nextVersion(from) : parseVersion(target)
  if (version === from) {
    process.stderr.write(`release: ${version} is already the current version — pass the next one or "next"\n`)
    return 1
  }

  const edits = releaseEdits({ files, version })
  if (edits.length === 0) {
    process.stderr.write(`release: nothing to change for ${version}\n`)
    return 1
  }

  process.stdout.write(`▸ ${from} → ${version} (${edits.length} files)\n`)
  for (const edit of edits) process.stdout.write(`  ${edit.path}  (${edit.why})\n`)
  if (dryRun) {
    process.stdout.write('dry run: nothing written\n')
    return 0
  }

  for (const edit of edits) writeFileSync(join(repo, edit.path), edit.after)

  // The changelog covers what changed since the previous tag; on the very first
  // release there is no tag, so every commit is part of it.
  const lastTag = (() => {
    try {
      return git(['describe', '--tags', '--abbrev=0'])
    } catch {
      return ''
    }
  })()
  const range = lastTag === '' ? 'HEAD' : `${lastTag}..HEAD`
  const commits = git(['log', '--format=%s', range]).split('\n').filter(Boolean)
  const entry = changelogEntry({ version, date: new Date().toISOString().slice(0, 10), commits })
  const changelogPath = join(repo, 'CHANGELOG.md')
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : undefined
  writeFileSync(changelogPath, insertChangelog(existing, entry))
  process.stdout.write(`  CHANGELOG.md  (${commits.length} commits since ${lastTag || 'the first commit'})\n`)

  if (verify) {
    sh('pnpm', ['build'], 'build')
    sh('pnpm', ['test:unit'], 'unit tests')
    sh('pnpm', ['-r', '--no-sort', 'run', 'typecheck'], 'typecheck')
  }

  sh('git', ['add', '-A'], 'stage')
  sh('git', ['commit', '-m', `chore(release): ${version}`], 'commit')
  sh('git', ['tag', '-a', `v${version}`, '-m', `v${version}`], 'tag')

  process.stdout.write(
    `\n✓ ${version} is committed and tagged.\n` +
      `  review:  git show --stat v${version}\n` +
      `  publish: git push origin main --follow-tags\n` +
      `  (the tag triggers .github/workflows/release.yml, which publishes to npm)\n`,
  )
  return 0
}

process.exitCode = main(process.argv.slice(2))
