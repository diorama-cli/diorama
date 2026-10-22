import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitRepoView, GitService, openMount } from '../src/server/git.ts'
import { discoverRepositories, nestedPaths } from '../src/server/repos.ts'

/**
 * Several repositories under one mount (contract.md §3.2, v0.10): side by side,
 * nested, and pruned by the ignore rules.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })
}

/** Make `dir` a committed repository with one committed file and one change. */
function initRepo(dir: string, name = 'file.txt'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), 'one\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  writeFileSync(join(dir, name), 'one\ntwo\n')
}

/** A scratch directory removed after the test. */
function scratch(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'diorama-repos-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('repos: side-by-side repositories are all found, shallowest first', async t => {
  const root = scratch(t)
  initRepo(join(root, 'apps', 'api'))
  initRepo(join(root, 'apps', 'web'))
  initRepo(join(root, 'tools'))
  const found = await discoverRepositories({ root, maxDepth: 3 })
  assert.deepEqual(found.repos.map(repo => repo.path), ['tools', 'apps/api', 'apps/web'])
  assert.equal(found.truncated, false)
})

test('repos: the mount root itself is a repository, and its inner ones are found too', async t => {
  const root = scratch(t)
  initRepo(root)
  initRepo(join(root, 'vendor', 'lib'))
  const found = await discoverRepositories({ root, maxDepth: 3 })
  assert.deepEqual(found.repos.map(repo => repo.path), ['', 'vendor/lib'])
})

test('repos: node_modules and .git are pruned by the default ignore rules', async t => {
  const root = scratch(t)
  initRepo(join(root, 'node_modules', 'dep'))
  initRepo(join(root, 'packages', 'app'))
  const found = await discoverRepositories({ root, maxDepth: 4 })
  assert.deepEqual(found.repos.map(repo => repo.path), ['packages/app'])
})

test('repos: the ignore list is configurable', async t => {
  const root = scratch(t)
  initRepo(join(root, 'build', 'generated'))
  initRepo(join(root, 'packages', 'app'))
  const kept = await discoverRepositories({ root, maxDepth: 3 })
  assert.deepEqual(kept.repos.map(repo => repo.path), ['build/generated', 'packages/app'])
  const pruned = await discoverRepositories({ root, maxDepth: 3, ignore: ['build'] })
  assert.deepEqual(pruned.repos.map(repo => repo.path), ['packages/app'])
})

test('repos: depth is bounded, and 0 looks at the mount root only', async t => {
  const root = scratch(t)
  initRepo(join(root, 'a', 'b', 'c'))
  assert.deepEqual((await discoverRepositories({ root, maxDepth: 1 })).repos, [])
  assert.deepEqual((await discoverRepositories({ root, maxDepth: 2 })).repos, [])
  assert.deepEqual((await discoverRepositories({ root, maxDepth: 3 })).repos.map(repo => repo.path), ['a/b/c'])
})

test('repos: maxRepos truncates the list and says so', async t => {
  const root = scratch(t)
  for (const name of ['a', 'b', 'c']) initRepo(join(root, name))
  const found = await discoverRepositories({ root, maxDepth: 1, maxRepos: 2 })
  assert.equal(found.repos.length, 2)
  assert.equal(found.truncated, true)
})

test('repos: a .git file (submodule, worktree) still marks a repository root', async t => {
  const root = scratch(t)
  const outer = join(root, 'outer')
  initRepo(outer)
  // A gitfile is what a submodule and a linked worktree both look like.
  const inner = join(outer, 'sub')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, '.git'), 'gitdir: ../../.git/modules/sub\n')
  const found = await discoverRepositories({ root, maxDepth: 3 })
  assert.deepEqual(found.repos.map(repo => repo.path), ['outer', 'outer/sub'])
})

test('repos: a bare repository is a repository', async t => {
  const root = scratch(t)
  git(root, 'init', '-q', '--bare', 'bare.git')
  const found = await discoverRepositories({ root, maxDepth: 2 })
  assert.deepEqual(found.repos.map(repo => repo.path), ['bare.git'])
})

test('repos: nestedPaths lists the repositories strictly inside one', () => {
  const repos = [
    { path: '', root: '/r' },
    { path: 'apps/api', root: '/r/apps/api' },
    { path: 'apps/api/vendor', root: '/r/apps/api/vendor' },
    { path: 'web', root: '/r/web' },
  ]
  assert.deepEqual(nestedPaths(repos, ''), ['apps/api', 'apps/api/vendor', 'web'])
  assert.deepEqual(nestedPaths(repos, 'apps/api'), ['vendor'])
  assert.deepEqual(nestedPaths(repos, 'web'), [])
})

test('git: a mount of several repositories reports each one with its repo path', async t => {
  const root = scratch(t)
  initRepo(join(root, 'apps', 'api'))
  initRepo(join(root, 'apps', 'web'))
  const opened = await openMount({ mountId: 'm', root, config: undefined } as never)
  assert.ok('service' in opened, JSON.stringify(opened))
  const svc = opened.service
  assert.deepEqual(svc.repos().map(repo => repo.path), ['apps/api', 'apps/web'])
  const entries = await svc.status()
  assert.deepEqual(entries.map(entry => entry.repo).sort(), ['apps/api', 'apps/web'])
  assert.deepEqual(entries.map(entry => entry.file).sort(), ['apps/api/file.txt', 'apps/web/file.txt'])
  // One repository at a time.
  const one = await svc.status('apps/web')
  assert.deepEqual(one.map(entry => entry.file), ['apps/web/file.txt'])
  // A path decides its repository by itself.
  const diff = await svc.diff({ path: 'apps/api/file.txt' })
  assert.equal(diff.entries.length, 1)
  assert.equal(diff.entries[0]?.repo, 'apps/api')
})

test('git: a nested repository is hidden from the outer view', async t => {
  const root = scratch(t)
  const outer = join(root, 'outer')
  initRepo(outer)
  initRepo(join(outer, 'vendor', 'lib'))
  const opened = await openMount({ mountId: 'm', root, config: undefined } as never)
  assert.ok('service' in opened, JSON.stringify(opened))
  const svc = opened.service
  assert.deepEqual(svc.repos().map(repo => repo.path), ['outer', 'outer/vendor/lib'])
  const entries = await svc.status()
  // The outer repository reports its own file, never the nested repository's.
  const outerEntries = entries.filter(entry => entry.repo === 'outer')
  assert.deepEqual(outerEntries.map(entry => entry.file), ['outer/file.txt'])
  const innerEntries = entries.filter(entry => entry.repo === 'outer/vendor/lib')
  assert.deepEqual(innerEntries.map(entry => entry.file), ['outer/vendor/lib/file.txt'])
  // Both changes are visible in the one flat list.
  assert.equal(entries.length, 2)
})

test('git: a mount below its repository still answers for the whole mount', async t => {
  const root = scratch(t)
  initRepo(root)
  const sub = join(root, 'src')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'app.js'), 'x\n')
  const opened = await openMount({ mountId: 'm', root: sub, config: undefined } as never)
  assert.ok('service' in opened, JSON.stringify(opened))
  const svc = opened.service
  // The enclosing repository is the mount's own repository.
  assert.deepEqual(svc.repos().map(repo => repo.path), [''])
  const entries = await svc.status()
  assert.deepEqual(entries.map(entry => entry.file), ['app.js'])
  assert.equal(entries[0]?.repo, '')
})

test('git: a mount with no repository has no service', async t => {
  const root = scratch(t)
  writeFileSync(join(root, 'plain.txt'), 'x\n')
  const opened = await openMount({ mountId: 'm', root, config: undefined } as never)
  assert.ok('reason' in opened)
  assert.match(opened.reason, /no git repository|not a git working tree/)
})

test('git: repos() is proxyable and carries the truncation flag', async () => {
  const view = new GitRepoView('/tmp/x', '/tmp/x')
  const svc = new GitService('/tmp/x', [view], true)
  assert.deepEqual(svc.repos(), [{ path: '', truncated: true }])
  assert.ok(svc.describe().some(entry => entry.name === 'repos'))
})
