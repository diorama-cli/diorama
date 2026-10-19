import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitService, MAX_LOG_LIMIT, parsePorcelainZ } from '../src/server/git.ts'
import { createDispatcher } from '../src/server/rpc.ts'

/**
 * `ctx.git` (contract.md §3.2): a read-only view of the working tree, rooted at
 * a mount that may be a subdirectory of a larger repository.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })
}

/** A committed repository with one modified, one added, one untracked and one deleted file. */
function repo(files: Record<string, string> = {}): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), 'diorama-git-'))
  const write = (path: string, text: string): void => {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text)
  }
  write('src/app.js', 'one\ntwo\nthree\n')
  write('README.md', '# r\n')
  write('gone.txt', 'bye\n')
  write('keep.txt', 'same\n')
  for (const [path, text] of Object.entries(files)) write(path, text)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'first')
  // Working-tree changes: modified, deleted, untracked.
  writeFileSync(join(root, 'src/app.js'), 'one\nTWO\nthree\nfour\n')
  rmSync(join(root, 'gone.txt'))
  write('new.txt', 'brand new\n')
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

function service(root: string): GitService {
  return new GitService(root, root)
}

test('git: status classifies modified, deleted and untracked files', async t => {
  const fixture = repo()
  t.after(() => fixture.dispose())
  const entries = await service(fixture.root).status()
  const byPath = new Map(entries.map(entry => [entry.file, entry]))
  assert.equal(byPath.get('src/app.js')?.kind, 'modified')
  assert.equal(byPath.get('gone.txt')?.kind, 'deleted')
  assert.equal(byPath.get('new.txt')?.kind, 'untracked')
  assert.equal(byPath.get('new.txt')?.status, '??')
  // Unchanged files never appear.
  assert.equal(byPath.has('keep.txt'), false)
})

test('git: diff returns one unified diff per changed file, untracked as an addition', async t => {
  const fixture = repo()
  t.after(() => fixture.dispose())
  const result = await service(fixture.root).diff()
  assert.equal(result.truncated, false)
  const entries = result.entries.filter(entry => !('error' in entry))
  const app = entries.find(entry => entry.file === 'src/app.js')
  assert.ok(app !== undefined && 'text' in app)
  assert.match(app.text ?? '', /^diff --git a\/src\/app\.js b\/src\/app\.js/m)
  assert.match(app.text ?? '', /\+TWO/)
  assert.match(app.text ?? '', /\+four/)
  // An untracked file comes back as an addition without text (the renderer
  // reads it through ctx.fs; see the contract note).
  const added = entries.find(entry => entry.file === 'new.txt')
  assert.equal(added?.kind, 'added')
  assert.equal('text' in (added ?? {}), false)
})

test('git: diff scopes by file and by subtree', async t => {
  const fixture = repo()
  t.after(() => fixture.dispose())
  const svc = service(fixture.root)
  const one = await svc.diff({ path: 'src/app.js' })
  assert.deepEqual(one.entries.map(entry => entry.file), ['src/app.js'])
  // The unscoped call covers every change, git's path order (not creation order).
  const all = await svc.diff()
  assert.deepEqual([...all.entries.map(entry => entry.file)].sort(), ['gone.txt', 'new.txt', 'src/app.js'])
  // A path that did not change: no entries (it exists, so it is not ENOENT).
  const unchanged = await svc.diff({ path: 'keep.txt' })
  assert.deepEqual(unchanged.entries, [])
  const subtree = await svc.diff({ scope: 'src' })
  assert.deepEqual(subtree.entries.map(entry => entry.file), ['src/app.js'])
  await assert.rejects(svc.diff({ path: 'nope.txt' }), /ENOENT/)
  await assert.rejects(svc.diff({ path: '../outside' }), /EOUTSIDE/)
  await assert.rejects(svc.diff({ base: 'index' as never }), /EINVAL/)
})

test('git: renames carry oldPath', async t => {
  const fixture = repo()
  t.after(() => fixture.dispose())
  git(fixture.root, 'mv', 'keep.txt', 'kept.txt')
  const entry = (await service(fixture.root).status()).find(item => item.file === 'kept.txt')
  assert.equal(entry?.kind, 'renamed')
  assert.equal(entry?.oldPath, 'keep.txt')
})

test('git: log is newest first, honours limit, and rejects out-of-range limits', async t => {
  const fixture = repo()
  t.after(() => fixture.dispose())
  writeFileSync(join(fixture.root, 'keep.txt'), 'changed\n')
  git(fixture.root, 'commit', '-q', '-am', 'second')
  const svc = service(fixture.root)
  const entries = await svc.log({ limit: 1 })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.subject, 'second')
  assert.equal(entries[0]?.sha.length, 40)
  assert.ok((entries[0]?.at ?? 0) > 0)
  assert.ok((await svc.log()).length >= 2)
  await assert.rejects(svc.log({ limit: 0 }), /EINVAL/)
  await assert.rejects(svc.log({ limit: MAX_LOG_LIMIT + 1 }), /EINVAL/)
})

test('git: a mount inside a subdirectory only sees its own subtree', async t => {
  const fixture = repo()
  t.after(() => fixture.dispose())
  const sub = join(fixture.root, 'src')
  // Make the subdirectory itself dirty: the fixture's changes are elsewhere.
  writeFileSync(join(sub, 'app.js'), 'one\nsub\n')
  const svc = new GitService(sub, fixture.root)
  const entries = await svc.status()
  assert.deepEqual(entries.map(entry => entry.file), ['app.js'])
  const diff = await svc.diff({ path: 'app.js' })
  assert.equal(diff.entries.length, 1)
  // The repository file outside the mount is not addressable from it.
  await assert.rejects(svc.diff({ path: 'new.txt' }), /ENOENT/)
  const log = await svc.log({ limit: 5 })
  assert.ok(log.length >= 1, 'log() is scoped to the mount subtree but still reports commits')
})

test('git: binary files report binary instead of text', async t => {
  const fixture = repo({ 'blob.bin': 'x' })
  t.after(() => fixture.dispose())
  writeFileSync(join(fixture.root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 5]))
  const entry = (await service(fixture.root).diff({ path: 'blob.bin' })).entries[0]
  assert.equal(entry !== undefined && 'binary' in entry, true)
  assert.equal(entry !== undefined && 'text' in entry, false)
})

test('git: a directory that is not a repository has no working tree', async t => {
  const root = mkdtempSync(join(tmpdir(), 'diorama-nogit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { detectRepository } = await import('../src/server/git.ts')
  const detected = await detectRepository(root)
  // The temp dir may sit under a repository on some machines; only assert when it does not.
  if (!('reason' in detected)) return
  assert.match(detected.reason, /not a git working tree/)
})

test('git: the RPC dispatcher proxies only the described methods', async t => {
  const fixture = repo()
  t.after(() => fixture.dispose())
  const svc = service(fixture.root)
  const dispatcher = createDispatcher(() => ({ git: svc }))
  const status = (await dispatcher.call('git.status', [])) as { file: string }[]
  assert.ok(status.some(entry => entry.file === 'src/app.js'))
  await assert.rejects(dispatcher.call('git.checkout', []), /EMETHOD/)
  await assert.rejects(dispatcher.call('git.diff', [{}, {}]), /EBADREQUEST/)
})

test('git: porcelain -z parsing keeps renames and drops malformed records', () => {
  const records = parsePorcelainZ(' M src/a.js\0?? new.txt\0R  kept.txt\0old.txt\0')
  assert.deepEqual(records, [
    { status: ' M', file: 'src/a.js' },
    { status: '??', file: 'new.txt' },
    { status: 'R ', file: 'kept.txt', oldFile: 'old.txt' },
  ])
  assert.deepEqual(parsePorcelainZ(''), [])
})

test('git: a mount reached through a symlink still sees its changes', async t => {
  const fixture = repo()
  t.after(() => fixture.dispose())
  // `/tmp` is a symlink on macOS: a mount root spelled through it is not a
  // prefix of the realpath'ed working tree, and path filtering must not drop
  // every entry because of that (caught live: "工作区没有改动" on a dirty repo).
  const link = `${fixture.root}-link`
  symlinkSync(fixture.root, link)
  t.after(() => rmSync(link, { force: true }))
  // `rev-parse` reports the realpath of the working tree (as the service gets it).
  const repoRoot = realpathSync(fixture.root)
  const svc = new GitService(link, repoRoot)
  const entries = await svc.status()
  assert.ok(entries.some(entry => entry.file === 'src/app.js'), `status was ${JSON.stringify(entries)}`)
  const diff = await svc.diff({ path: 'src/app.js' })
  assert.equal(diff.entries.length, 1)
})
