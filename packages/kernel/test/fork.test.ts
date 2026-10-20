/**
 * `ctx.fork()` lifecycle (contract.md §2.5): one plugin graph per process,
 * one child context per directory, and the ordered unmount.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from 'cordis'
import { defaultConfig } from '../src/server/config.ts'
import { FsService, fsHalf } from '../src/server/fs.ts'
import { gitHalf, GitService } from '../src/server/git.ts'
import {
  createPluginHost,
  forkMount,
  onMountFailure,
  type MountInfo,
  type Mounts,
  type PluginHost,
} from '../src/server/plugins.ts'

function project(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'di-fork-'))
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A service plugin shaped like `fs`: registers per mount, cleans up per mount. */
function watcherPlugin(log: string[]) {
  return {
    name: 'watcher',
    inject: ['diorama'],
    apply(ctx: { diorama: { mounts: Mounts } }) {
      log.push('apply')
      ctx.diorama.mounts.onMount((_mountCtx, info) => {
        log.push(`mount:${info.mountId}`)
        return () => log.push(`unmount:${info.mountId}`)
      })
    },
  }
}

test('fork: plugin apply runs once, every mount gets its own fs and mountId', async t => {
  const a = project()
  const b = project()
  t.after(() => {
    a.dispose()
    b.dispose()
  })
  const log: string[] = []
  const host = await createPluginHost(() => {})
  t.after(() => host.dispose())
  await host.load([watcherPlugin(log)])
  await host.load([fsHalf])
  assert.deepEqual(log, ['apply'], 'apply runs once, before any mount')

  const one = await forkMount(host, { root: a.dir, mountId: 'one', config: defaultConfig() })
  const two = await forkMount(host, { root: b.dir, mountId: 'two', config: defaultConfig() })
  assert.deepEqual(log, ['apply', 'mount:one', 'mount:two'])
  assert.ok(one.fs instanceof FsService)
  assert.ok(two.fs instanceof FsService)
  assert.notEqual(one.fs, two.fs, 'each mount has its own FsService')
  assert.notEqual(one.ctx, two.ctx)
  assert.equal(one.fs.root, a.dir)
  assert.equal(two.fs.root, b.dir)
  assert.equal((one.ctx as unknown as { mountId: string }).mountId, 'one')
  assert.deepEqual(one.fs.describe().map(method => method.name).sort(), ['list', 'readBytes', 'readText', 'stat'])
  assert.deepEqual(host.mounts.list().map(info => info.mountId).sort(), ['one', 'two'])
  await one.dispose()
  await two.dispose()
})

test('fork: the root ctx has no fs; only a mount does', async t => {
  const a = project()
  t.after(() => a.dispose())
  const host = await createPluginHost(() => {})
  t.after(() => host.dispose())
  await host.load([fsHalf])
  const tree = await forkMount(host, { root: a.dir, mountId: 'm1', config: defaultConfig() })
  t.after(() => tree.dispose())
  // Cordis answers `undefined` for a service provided only on a fork (it is
  // not a getter that throws): a plugin on the root cannot reach a directory.
  assert.equal((host.root as unknown as { fs: unknown }).fs, undefined)
  assert.equal(typeof (tree.ctx as unknown as { fs: FsService }).fs.list, 'function')
})

test('fork: onMount callbacks registered after a mount is applied immediately; unmount runs disposers', async t => {
  const a = project()
  const b = project()
  t.after(() => {
    a.dispose()
    b.dispose()
  })
  const host = await createPluginHost(() => {})
  t.after(() => host.dispose())
  const seen: string[] = []
  const one = await forkMount(host, { root: a.dir, mountId: 'one', config: defaultConfig() })
  const stop = host.mounts.onMount((_ctx, info) => {
    seen.push(`late:${info.mountId}`)
    return () => seen.push(`late-dispose:${info.mountId}`)
  })
  assert.deepEqual(seen, ['late:one'], 'a late callback is applied to existing mounts')

  const two = await forkMount(host, { root: b.dir, mountId: 'two', config: defaultConfig() })
  assert.deepEqual(seen, ['late:one', 'late:two'])

  await one.dispose()
  assert.deepEqual(seen, ['late:one', 'late:two', 'late-dispose:one'])
  assert.deepEqual(host.mounts.list().map(info => info.mountId), ['two'], 'an unmounted id is gone from list()')
  // Disposing the `onMount` handle runs its disposers for the remaining mounts.
  stop()
  assert.deepEqual(seen, ['late:one', 'late:two', 'late-dispose:one', 'late-dispose:two'])
  await two.dispose()
})

test('fork: remounting the same directory uses a new mountId and a fresh child context', async t => {
  const a = project()
  t.after(() => a.dispose())
  const host = await createPluginHost(() => {})
  t.after(() => host.dispose())
  await host.load([fsHalf])
  const first = await forkMount(host, { root: a.dir, mountId: 'first', config: defaultConfig() })
  const firstFs = first.fs
  await first.dispose()
  const second = await forkMount(host, { root: a.dir, mountId: 'second', config: defaultConfig() })
  t.after(() => second.dispose())
  assert.notEqual(second.ctx, first.ctx)
  assert.notEqual(second.fs, firstFs)
  assert.notEqual(second.mountId, first.mountId)
})

test('fork: disposing one mount leaves the other mounts’ services intact', async t => {
  // Regression for the S3 bug: every mount must own its services through its
  // own fiber + isolate key. A shared provide made A's dispose delete B's fs.
  const a = project()
  const b = project()
  t.after(() => {
    a.dispose()
    b.dispose()
  })
  const host = await createPluginHost(() => {})
  t.after(() => host.dispose())
  await host.load([fsHalf])
  const one = await forkMount(host, { root: a.dir, mountId: 'one', config: defaultConfig() })
  const two = await forkMount(host, { root: b.dir, mountId: 'two', config: defaultConfig() })
  const rootOf = (tree: { ctx: unknown }): string | undefined =>
    (tree.ctx as { get(name: string): { root?: string } | undefined }).get('fs')?.root
  assert.equal(rootOf(one), a.dir)
  assert.equal(rootOf(two), b.dir)
  await one.dispose()
  assert.equal(rootOf(one), undefined, 'the disposed mount loses its services')
  assert.equal(rootOf(two), b.dir, 'the other mount keeps its own fs')
  assert.equal(await two.fs.readText('a.txt'), 'hello\n')
  await two.dispose()
})

test('fork: mount info carries port, url and configFile (contract.md §3.5)', async t => {
  const a = project()
  t.after(() => a.dispose())
  const host = await createPluginHost(() => {})
  t.after(() => host.dispose())
  const infos: MountInfo[] = []
  host.mounts.onMount((_ctx, info) => {
    infos.push(info)
  })
  const tree = await forkMount(host, {
    root: a.dir,
    mountId: 'x',
    config: defaultConfig(),
    port: 54321,
    url: 'http://127.0.0.1:54321/',
    configFile: '/tmp/diorama.toml',
  })
  t.after(() => tree.dispose())
  assert.deepEqual(
    { root: infos[0]?.root, port: infos[0]?.port, url: infos[0]?.url, configFile: infos[0]?.configFile },
    { root: a.dir, port: 54321, url: 'http://127.0.0.1:54321/', configFile: '/tmp/diorama.toml' },
  )
})

test('fork: a throwing onMount callback is reported and does not stop the others', async t => {
  const a = project()
  t.after(() => a.dispose())
  const host = await createPluginHost(() => {})
  t.after(() => host.dispose())
  const seen: string[] = []
  const failures: string[] = []
  const stopListening = onMountFailure((mountId, failure) => failures.push(`${mountId}:${(failure as Error).message}`))
  t.after(() => stopListening())
  host.mounts.onMount(() => {
    throw new Error('broken plugin')
  })
  host.mounts.onMount((_ctx, info) => {
    seen.push(info.mountId)
  })
  const tree = await forkMount(host, { root: a.dir, mountId: 'k', config: defaultConfig() })
  t.after(() => tree.dispose())
  assert.deepEqual(seen, ['k'])
  assert.deepEqual(failures, ['k:broken plugin'])
})

test('fork: the host keeps its own mounts when a tree is disposed (two hosts would not share)', async t => {
  const a = project()
  const b = project()
  t.after(() => {
    a.dispose()
    b.dispose()
  })
  const left: PluginHost = await createPluginHost(() => {})
  const right: PluginHost = await createPluginHost(() => {})
  t.after(async () => {
    await left.dispose()
    await right.dispose()
  })
  const l = await forkMount(left, { root: a.dir, mountId: 'l', config: defaultConfig() })
  const r = await forkMount(right, { root: b.dir, mountId: 'r', config: defaultConfig() })
  assert.deepEqual(left.mounts.list().map(info => info.mountId), ['l'])
  assert.deepEqual(right.mounts.list().map(info => info.mountId), ['r'])
  await l.dispose()
  await r.dispose()
})

/**
 * Two directories of the **same** repository (contract.md §2.5, §3.2): each
 * mount's `git` is its own service. Cordis isolates per service name, so a
 * mount service that is not in `MOUNT_SERVICES` shares the root's key — the
 * second mount then collides (`service "git" has been registered`) and the
 * root can resolve the wrong mount's repository.
 */
test('fork: each mount of one repository gets its own git, and the root gets none', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'di-iso-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const run = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo })
  }
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'top.txt'), 'x\n')
  writeFileSync(join(repo, 'sub', 'inner.txt'), 'y\n')
  run('init', '-q', '-b', 'main')
  run('add', '-A')
  run('commit', '-q', '-m', 'base')

  const logs: string[] = []
  const host = await createPluginHost(message => logs.push(message))
  await host.load([fsHalf, gitHalf])
  const inner = await forkMount(host, { root: join(repo, 'sub'), mountId: 'inner', log: message => logs.push(message) })
  const outer = await forkMount(host, { root: repo, mountId: 'outer', log: message => logs.push(message) })
  // `gitHalf` detects on an async fiber: let it answer.
  await new Promise(resolve => setTimeout(resolve, 500))

  const gitOf = (ctx: Context): GitService | undefined =>
    (ctx as unknown as { get(name: string): unknown }).get('git') as GitService | undefined
  const a = gitOf(inner.ctx)
  const b = gitOf(outer.ctx)
  assert.ok(a instanceof GitService)
  assert.ok(b instanceof GitService)
  assert.notEqual(a, b)
  // Each service serves its own mount (the same working tree, different mount roots).
  assert.equal(a.root, realpathSync(join(repo, 'sub')))
  assert.equal(b.root, realpathSync(repo))
  // The root sees neither, and nothing collided.
  assert.equal(gitOf(host.root), undefined)
  assert.deepEqual(logs.filter(message => /has been registered/.test(message)), [])

  // Disposing one mount takes only its own service away.
  await inner.dispose()
  assert.equal(gitOf(inner.ctx), undefined)
  assert.ok(gitOf(outer.ctx) instanceof GitService)
  await outer.dispose()
  await host.dispose()
})
