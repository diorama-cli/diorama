import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectRepository, GitRepoView, GitService, gitEnvironment, MAX_LOG_LIMIT, openMount, parsePorcelainZ } from '../src/server/git.ts'
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

/** A mount-level service over one repository rooted at `root`. */
function service(root: string): GitService {
  return new GitService(root, [new GitRepoView(root, root)])
}

/** A mount-level service whose single repository is `repoRoot`, seen from `root`. */
function mountAt(root: string, repoRoot: string, nested: string[] = []): GitService {
  return new GitService(root, [new GitRepoView(root, repoRoot, nested)])
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
  // v0.6: `'index'` is a legitimate base; a malformed revision is not.
  await assert.doesNotReject(svc.diff({ base: 'index' }))
  await assert.rejects(svc.diff({ base: 'index..HEAD' }), /EINVAL/)
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
  const svc = mountAt(sub, fixture.root)
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
  const svc = mountAt(link, repoRoot)
  const entries = await svc.status()
  assert.ok(entries.some(entry => entry.file === 'src/app.js'), `status was ${JSON.stringify(entries)}`)
  const diff = await svc.diff({ path: 'src/app.js' })
  assert.equal(diff.entries.length, 1)
})

/** A two-commit history with a root commit, a rename and a binary file. */
function history(): { root: string; first: string; second: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), 'diorama-git-hist-'))
  const write = (path: string, text: string | Buffer): void => {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text)
  }
  write('src/app.js', 'one\ntwo\n')
  write('README.md', '# r\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'first')
  const first = git(root, 'rev-parse', 'HEAD').trim()
  write('src/app.js', 'one\nTWO\nthree\n')
  write('blob.bin', Buffer.from([0, 1, 2, 3]))
  git(root, 'mv', 'README.md', 'GUIDE.md')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'second\n\nwith a body line')
  const second = git(root, 'rev-parse', 'HEAD').trim()
  return { root, first, second, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test('git: show returns one file of one commit as a diff', async t => {
  const fixture = history()
  t.after(() => fixture.dispose())
  const svc = service(fixture.root)
  const entry = await svc.show(fixture.second, 'src/app.js')
  assert.equal(entry.file, 'src/app.js')
  assert.equal(entry.kind, 'modified')
  assert.match(entry.text ?? '', /^\+\+\+ b\/src\/app\.js$/m)
  assert.match(entry.text ?? '', /^\+three$/m)
  // `show` is per file: given the new path of a rename, its diff is the
  // addition of that path (the rename *pair* is `showCommit().files`' job).
  const moved = await svc.show(fixture.second, 'GUIDE.md')
  assert.equal(moved.kind, 'added')
  assert.match(moved.text ?? '', /^new file mode /m)
  // A binary file has no text.
  const binary = await svc.show(fixture.second, 'blob.bin')
  assert.equal(binary.binary, true)
  assert.equal(binary.text, undefined)
  // A root commit always has a new-file diff, not an error.
  const rootCommit = await svc.show(fixture.first, 'src/app.js')
  assert.equal(rootCommit.kind, 'added')
  assert.match(rootCommit.text ?? '', /^\+one$/m)
  // Not in this commit, and not in its parent either.
  await assert.rejects(svc.show(fixture.first, 'blob.bin'), /ENOENT/)
  await assert.rejects(svc.show('deadbeef', 'src/app.js'), /ENOENT/)
  await assert.rejects(svc.show('../etc/passwd', 'src/app.js'), /EINVAL/)
  await assert.rejects(svc.show(fixture.second, '../x'), /EOUTSIDE|EINVAL/)
})

test('git: showCommit carries the message and the file list', async t => {
  const fixture = history()
  t.after(() => fixture.dispose())
  const svc = service(fixture.root)
  const detail = await svc.showCommit(fixture.second)
  assert.equal(detail.sha, fixture.second)
  assert.equal(detail.shortSha.length, 7)
  assert.equal(detail.subject, 'second')
  assert.match(detail.message, /^second\n\nwith a body line/)
  assert.equal(detail.author, 't')
  assert.ok(detail.at > 0)
  const files = detail.files.map(file => file.file).sort()
  assert.deepEqual(files, ['GUIDE.md', 'blob.bin', 'src/app.js'])
  const renamed = detail.files.find(file => file.file === 'GUIDE.md')
  assert.equal(renamed?.oldPath, 'README.md')
  const binary = detail.files.find(file => file.file === 'blob.bin')
  assert.equal(binary?.binary, true)
  // Short shas and revision syntax resolve; an unknown one does not.
  assert.equal((await svc.showCommit(fixture.second.slice(0, 7))).sha, fixture.second)
  assert.equal((await svc.showCommit('HEAD~1')).sha, fixture.first)
  await assert.rejects(svc.showCommit('no-such-branch'), /ENOENT/)
  await assert.rejects(svc.showCommit('HEAD...HEAD'), /EINVAL/)
})

test('git: blob returns the content at a commit, binary or text', async t => {
  const fixture = history()
  t.after(() => fixture.dispose())
  const svc = service(fixture.root)
  const old = await svc.blob(fixture.first, 'src/app.js')
  assert.equal(old.text, 'one\ntwo\n')
  assert.equal(old.size, 8)
  assert.equal(old.truncated, undefined)
  // The working tree now says THREE; the old commit still says two.
  const current = await svc.blob('HEAD', 'src/app.js')
  assert.match(current.text ?? '', /TWO/)
  const renamedBefore = await svc.blob(fixture.first, 'README.md')
  assert.equal(renamedBefore.text, '# r\n')
  // After the rename the old path is gone from HEAD (git says "path does not
  // exist", which is the contract's ENOENT for a missing path).
  await assert.rejects(svc.blob('HEAD', 'README.md'), /ENOENT/)
  const binary = await svc.blob('HEAD', 'blob.bin')
  assert.equal(binary.binary, true)
  assert.equal(binary.text, undefined)
  assert.equal(binary.size, 4)
  await assert.rejects(svc.blob('HEAD', 'nope.txt'), /ENOENT/)
})

test('git: diff base accepts the index and a commit', async t => {
  const fixture = history()
  t.after(() => fixture.dispose())
  const svc = service(fixture.root)
  // Stage one change and leave another unstaged.
  writeFileSync(join(fixture.root, 'src/app.js'), 'one\nTWO\nTHREE\n')
  git(fixture.root, 'add', 'src/app.js')
  writeFileSync(join(fixture.root, 'src/app.js'), 'one\nTWO\nTHREE\nfour\n')
  writeFileSync(join(fixture.root, 'untracked.txt'), 'new\n')

  const head = await svc.diff({ base: 'HEAD' })
  assert.ok(head.entries.some(entry => entry.file === 'untracked.txt'), 'HEAD diff lists untracked files')
  const index = await svc.diff({ base: 'index' })
  assert.deepEqual(index.entries.map(entry => entry.file), ['src/app.js'])
  assert.match((index.entries[0] as { text?: string }).text ?? '', /^\+THREE$/m)
  assert.doesNotMatch((index.entries[0] as { text?: string }).text ?? '', /^\+four$/m)

  // Against the root commit the working tree also differs in the rename.
  const vsFirst = await svc.diff({ base: fixture.first })
  assert.ok(vsFirst.entries.some(entry => entry.file === 'src/app.js'))
  // A revision that does not resolve is ENOENT; a malformed one is EINVAL.
  await assert.rejects(svc.diff({ base: 'no-such-branch' }), /ENOENT/)
  await assert.rejects(svc.diff({ base: 'HEAD..HEAD' }), /EINVAL/)
})

test('git: history methods are reachable over the RPC surface only when described', async t => {
  const fixture = history()
  t.after(() => fixture.dispose())
  const svc = service(fixture.root)
  const dispatcher = createDispatcher(() => ({ git: svc }))
  const detail = (await dispatcher.call('git.showCommit', [fixture.first])) as { subject: string }
  assert.equal(detail.subject, 'first')
  const blob = (await dispatcher.call('git.blob', [fixture.first, 'README.md'])) as { text?: string }
  assert.equal(blob.text, '# r\n')
  const shown = (await dispatcher.call('git.show', [fixture.second, 'src/app.js'])) as { kind: string }
  assert.equal(shown.kind, 'modified')
  await assert.rejects(dispatcher.call('git.commit', []), /EMETHOD/)
})

/**
 * The repository is decided by the mount, never by the environment the server
 * inherited (contract.md §3.2): `GIT_DIR` / `GIT_WORK_TREE` and friends outrank
 * `-C` in git itself, so a gateway started from a shell that carried them would
 * have answered with that shell's repository — one mount's files, another
 * repository's changes (the bug this test guards).
 */
test('git: the environment of the server cannot redirect the repository', async () => {
  const mine = repo()
  const other = repo()
  const poisoned = {
    GIT_DIR: join(other.root, '.git'),
    GIT_WORK_TREE: other.root,
    GIT_INDEX_FILE: join(other.root, '.git', 'index'),
    GIT_CONFIG_PARAMETERS: "'core.worktree'='" + other.root + "'",
  }
  const saved = new Map(Object.keys(poisoned).map(name => [name, process.env[name]]))
  Object.assign(process.env, poisoned)
  try {
    // Detection and every read answer for the mount, not for the environment.
    const detected = await detectRepository(mine.root)
    assert.deepEqual(detected, { repoRoot: realpathSync(mine.root) })
    const fixture = mountAt(mine.root, (detected as { repoRoot: string }).repoRoot)
    const entries = await fixture.status()
    assert.deepEqual(entries.map(entry => entry.file).sort(), ['gone.txt', 'new.txt', 'src/app.js'])
    assert.equal((await fixture.log({ limit: 1 }))[0]?.subject, 'first')
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    mine.dispose()
    other.dispose()
  }
})

test('git: the spawn environment drops every GIT_* variable it inherited', () => {
  const env = gitEnvironment({ PATH: '/usr/bin', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', HOME: '/home/u' })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.GIT_DIR, undefined)
  assert.equal(env.GIT_WORK_TREE, undefined)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(env.LC_ALL, 'C')
})
