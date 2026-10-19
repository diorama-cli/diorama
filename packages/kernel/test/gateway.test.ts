/**
 * The gateway mount table (contract.md §3.5, §7.3): one port per directory,
 * idempotent mounting, the unmount order.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultConfig } from '../src/server/config.ts'
import { Gateway, mountUrl, newMountId, type MountTree } from '../src/server/gateway.ts'
import type { BootManifest } from '../src/server/plan.ts'
import type { RpcDispatcher } from '../src/server/rpc.ts'

function tempDir(prefix = 'di-gw-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A directory with one file, plus its assets directory. */
function served(): { dir: string; root: string; assets: string; dispose(): void } {
  const dir = tempDir()
  const assets = join(dir, 'assets')
  mkdirSync(assets)
  writeFileSync(join(assets, 'index.html'), '<html><head></head><body>shell</body></html>')
  const root = join(dir, 'project')
  mkdirSync(root)
  writeFileSync(join(root, 'README.md'), '# hi\n')
  return { dir, root, assets, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Files in the mount root, answered over RPC-shaped HTTP for the transport tests. */
function stubDispatcher(): RpcDispatcher {
  return { call: async () => ({}), services: () => [] }
}

/** A tree whose dispose order we can observe. */
function stubTree(order: string[], label: string): MountTree {
  return {
    dispatcher: stubDispatcher(),
    async dispose() {
      order.push(`tree:${label}`)
    },
  }
}

function manifestOf(name: string): (mountId: string, port: number, url: string) => BootManifest {
  return (mountId, port, url) => ({
    kernel: 'diorama',
    contract: '0.5',
    mountId,
    root: '',
    port,
    url,
    plugins: [],
  })
}

test('gateway: two directories get two ports and their own /plugin.json', async t => {
  const a = served()
  const b = served()
  t.after(() => {
    a.dispose()
    b.dispose()
  })
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {} })
  t.after(() => gateway.close())
  const config = defaultConfig()
  const first = await gateway.mount({
    root: a.root,
    config,
    clientEntries: new Map(),
    manifest: (mountId, port, url) => ({ ...manifestOf('a')(mountId, port, url), root: a.root }),
    boot: async () => stubTree([], 'a'),
  })
  const second = await gateway.mount({
    root: b.root,
    config,
    clientEntries: new Map(),
    manifest: (mountId, port, url) => ({ ...manifestOf('b')(mountId, port, url), root: b.root }),
    boot: async () => stubTree([], 'b'),
  })
  const sa = first.mount.status
  const sb = second.mount.status
  assert.notEqual(sa.port, sb.port)
  assert.equal(sa.state, 'ok')
  assert.equal(sa.url, mountUrl(config.host, sa.port))
  // `/plugin.json` answers with the URL the mount actually listens on.
  for (const status of [sa, sb]) {
    const response = await fetch(`http://127.0.0.1:${status.port}/plugin.json`)
    const manifest = (await response.json()) as BootManifest
    assert.equal(manifest.mountId, status.mountId)
    assert.equal(manifest.url, status.url)
    assert.equal(manifest.port, status.port)
  }
  assert.deepEqual(gateway.list().map(mount => mount.mountId).sort(), [sa.mountId, sb.mountId].sort())
})

test('gateway: mounting the same root again is idempotent (same id, same port, created false)', async t => {
  const a = served()
  t.after(() => a.dispose())
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {} })
  t.after(() => gateway.close())
  const input = {
    root: a.root,
    config: { ...defaultConfig(), port: 0 },
    clientEntries: new Map(),
    manifest: manifestOf('a'),
    boot: async () => stubTree([], 'a'),
  }
  const first = await gateway.mount(input)
  // A symlinked spelling of the same directory resolves to the same mount.
  const second = await gateway.mount(input)
  assert.equal(second.created, false)
  assert.equal(second.mount.status.mountId, first.mount.status.mountId)
  assert.equal(second.mount.status.port, first.mount.status.port)
  assert.equal(gateway.list().length, 1)
})

test('gateway: an explicit port conflict is EADDRINUSE, not a silent retry', async t => {
  const a = served()
  t.after(() => a.dispose())
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {} })
  t.after(() => gateway.close())
  const first = await gateway.mount({
    root: a.root,
    config: { ...defaultConfig(), port: 0 },
    clientEntries: new Map(),
    manifest: manifestOf('a'),
    boot: async () => stubTree([], 'a'),
  })
  const other = served()
  t.after(() => other.dispose())
  await assert.rejects(
    gateway.mount({
      root: other.root,
      config: { ...defaultConfig(), port: first.mount.status.port },
      clientEntries: new Map(),
      manifest: manifestOf('b'),
      boot: async () => stubTree([], 'b'),
    }),
    (error: unknown) => (error as { code?: string }).code === 'EADDRINUSE',
  )
  assert.equal(gateway.list().length, 1)
})

test('gateway: unmount closes the port, then disposes the tree; the id can be unmounted twice', async t => {
  const a = served()
  t.after(() => a.dispose())
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {} })
  t.after(() => gateway.close())
  let port = 0
  const { mount } = await gateway.mount({
    root: a.root,
    config: defaultConfig(),
    clientEntries: new Map(),
    manifest: manifestOf('a'),
    boot: async () => stubTree([], 'a'),
  })
  port = mount.status.port
  assert.equal((await fetch(`http://127.0.0.1:${port}/plugin.json`)).status, 200)
  const removed = await gateway.unmount({ mountId: mount.status.mountId })
  assert.equal(removed?.root, mount.status.root)
  // The listener is closed: nothing answers any more.
  await assert.rejects(fetch(`http://127.0.0.1:${port}/plugin.json`))
  assert.deepEqual(gateway.list(), [])
  // Idempotent: a second unmount of the same id is not an error.
  assert.equal(await gateway.unmount({ mountId: mount.status.mountId }), undefined)
})

test('gateway: mounting a directory that does not exist is ENOTDIR', async t => {
  const a = served()
  t.after(() => a.dispose())
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {} })
  t.after(() => gateway.close())
  await assert.rejects(
    gateway.mount({
      root: join(a.dir, 'nope'),
      config: defaultConfig(),
      clientEntries: new Map(),
      manifest: manifestOf('x'),
      boot: async () => stubTree([], 'x'),
    }),
    (error: unknown) => (error as { code?: string }).code === 'ENOTDIR',
  )
})

test('gateway: a boot failure releases the port and leaves no mount behind', async t => {
  const a = served()
  t.after(() => a.dispose())
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {} })
  t.after(() => gateway.close())
  await assert.rejects(
    gateway.mount({
      root: a.root,
      config: defaultConfig(),
      clientEntries: new Map(),
      manifest: manifestOf('a'),
      boot: async () => {
        throw new Error('plugin tree exploded')
      },
    }),
    /exploded/,
  )
  assert.deepEqual(gateway.list(), [])
  // `ports` records what was handed out (diagnostics), not what is live.
  assert.equal(gateway.ports.length, 1)
})

test('gateway: mount ids are unique and URL building rewrites wildcard hosts', () => {
  assert.notEqual(newMountId(), newMountId())
  assert.match(newMountId(), /^[0-9a-f]{8}$/)
  assert.equal(mountUrl('127.0.0.1', 1234), 'http://127.0.0.1:1234/')
  assert.equal(mountUrl('0.0.0.0', 1234), 'http://127.0.0.1:1234/')
  assert.equal(mountUrl('::1', 1234), 'http://[::1]:1234/')
})

test('gateway: close unmounts everything', async t => {
  const a = served()
  const b = served()
  t.after(() => {
    a.dispose()
    b.dispose()
  })
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {} })
  await gateway.mount({
    root: a.root,
    config: defaultConfig(),
    clientEntries: new Map(),
    manifest: manifestOf('a'),
    boot: async () => stubTree([], 'a'),
  })
  await gateway.mount({
    root: b.root,
    config: defaultConfig(),
    clientEntries: new Map(),
    manifest: manifestOf('b'),
    boot: async () => stubTree([], 'b'),
  })
  await gateway.close()
  await delay(10)
  assert.deepEqual(gateway.list(), [])
})

test('gateway: degrade marks a mount, broadcasts once, and keeps it serving', async t => {
  const a = served()
  t.after(() => a.dispose())
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {}, restartDelayMs: 60_000 })
  t.after(() => gateway.close())
  const seen: string[] = []
  gateway.onStateChange((status, previous) => seen.push(`${previous}->${status.state}`))
  const { mount } = await gateway.mount({
    root: a.root,
    config: defaultConfig(),
    clientEntries: new Map(),
    manifest: manifestOf('a'),
    boot: async () => stubTree([], 'a'),
  })
  const degraded = gateway.degrade(mount.status.mountId, Object.assign(new Error('plugin exploded'), { code: 'EIO' }))
  assert.equal(degraded?.state, 'degraded')
  assert.equal(degraded?.lastError?.code, 'EIO')
  assert.equal(degraded?.lastError?.message, 'plugin exploded')
  // The port still answers (contract.md §11.1: no blocking).
  assert.equal((await fetch(`http://127.0.0.1:${mount.status.port}/plugin.json`)).status, 200)
  // A second failure while already degraded does not announce again.
  gateway.degrade(mount.status.mountId, new Error('again'))
  assert.deepEqual(seen, ['ok->degraded'])
  // A healthy request recovers it.
  const recovered = gateway.recover(mount.status.mountId)
  assert.equal(recovered?.state, 'ok')
  assert.equal(recovered?.lastError, undefined)
  assert.deepEqual(seen, ['ok->degraded', 'degraded->ok'])
})

test('gateway: a degraded mount auto-restarts once, then stays put', async t => {
  const a = served()
  t.after(() => a.dispose())
  // A short delay keeps the test fast; production is 2s (DEFAULT_RESTART_DELAY_MS).
  const gateway = new Gateway({ assetsRoot: a.assets, log: () => {}, restartDelayMs: 30 })
  t.after(() => gateway.close())
  const boots: string[] = []
  const input = {
    root: a.root,
    config: defaultConfig(),
    clientEntries: new Map(),
    manifest: manifestOf('a'),
    boot: async (mountId: string) => {
      boots.push(mountId)
      return stubTree([], mountId)
    },
  }
  const { mount } = await gateway.mount(input)
  gateway.degrade(mount.status.mountId, new Error('first failure'))
  // The restart unmounts and mounts again under a new id.
  await new Promise(resolve => setTimeout(resolve, 150))
  const live = gateway.list()
  assert.equal(live.length, 1)
  assert.notEqual(live[0]?.mountId, mount.status.mountId)
  assert.equal(live[0]?.state, 'ok')
  assert.equal(boots.length, 2)

  // A second degradation on the fresh mount is not restarted again.
  gateway.degrade(live[0]!.mountId, new Error('second failure'))
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(boots.length, 2, 'one automatic restart per mount lineage')
  assert.equal(gateway.list()[0]?.state, 'degraded')
})
