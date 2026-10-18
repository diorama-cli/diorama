import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FsService, MAX_BINARY_BYTES } from '../src/server/fs.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'diorama-fs-'))
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'a.txt'), 'hello\n')
  writeFileSync(join(root, 'docs', 'b.md'), '# b\n')
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
  return root
}

test('ctx.fs: list, stat, readText, readBytes', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fs = new FsService(root)

  const entries = await fs.list('')
  assert.deepEqual(entries.map(entry => entry.path).sort(), ['a.txt', 'blob.bin', 'docs'])
  assert.equal(entries.find(entry => entry.path === 'docs')?.kind, 'dir')

  const info = await fs.stat('docs/b.md')
  assert.deepEqual([info.path, info.name, info.kind], ['docs/b.md', 'b.md', 'file'])

  assert.equal(await fs.readText('a.txt'), 'hello\n')
  assert.deepEqual([...(await fs.readBytes('blob.bin'))], [0, 1, 2, 3])
})

test('ctx.fs: error codes are the contract', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fs = new FsService(root)
  const code = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run()
    } catch (error) {
      return String((error as { code?: string }).code)
    }
    return 'none'
  }

  assert.equal(await code(() => fs.readText('missing.txt')), 'ENOENT')
  assert.equal(await code(() => fs.readText('docs')), 'EISDIR')
  assert.equal(await code(() => fs.list('a.txt')), 'ENOTDIR')
  assert.equal(await code(() => fs.readText('blob.bin')), 'EBINARY')
  assert.equal(await code(() => fs.readText('../escape')), 'EOUTSIDE')
  assert.equal(await code(() => fs.readText('/etc/passwd')), 'EINVAL')
})

test('ctx.fs: oversized files are ETOOLARGE before reading', async t => {
  const root = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'huge.bin'), Buffer.alloc(MAX_BINARY_BYTES + 1))
  const fs = new FsService(root)
  await assert.rejects(fs.readBytes('huge.bin'), /ETOOLARGE/)
})

test('ctx.fs: watch has its signature but emits nothing yet', () => {
  const fs = new FsService(process.cwd())
  const dispose = fs.watch('', () => {
    throw new Error('watch must not emit in M1')
  })
  assert.equal(typeof dispose, 'function')
  dispose()
})
