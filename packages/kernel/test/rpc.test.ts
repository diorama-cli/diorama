import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeValue, encodeValue, parseMethod } from '../src/shared/rpc.ts'
import { createDispatcher } from '../src/server/rpc.ts'
import { FsService } from '../src/server/fs.ts'

test('bytes survive the JSON envelope', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  const encoded = encodeValue({ path: 'a.bin', data: bytes })
  assert.deepEqual(encoded, { path: 'a.bin', data: { $bytes: 'AAEC+v8=' } })
  const decoded = decodeValue(encoded) as { path: string; data: Uint8Array }
  assert.ok(decoded.data instanceof Uint8Array)
  assert.deepEqual([...decoded.data], [0, 1, 2, 250, 255])
})

test('method names split into service and method', () => {
  assert.deepEqual(parseMethod('fs.readText'), { service: 'fs', name: 'readText' })
  assert.equal(parseMethod('readText'), undefined)
  assert.equal(parseMethod('fs.'), undefined)
})

test('the dispatcher only forwards described methods', async () => {
  const fs = new FsService(process.cwd())
  const call = createDispatcher(() => ({ fs }))
  const listed = await call.call('fs.list', [''])
  assert.ok(Array.isArray(listed))
  await assert.rejects(call.call('fs.writeFile', ['x']), /EMETHOD/)
  await assert.rejects(call.call('nope.list', []), /ESERVICE/)
  await assert.rejects(call.call('fs.readText', ['a', 'b', 'c']), /EBADREQUEST/)
  await assert.rejects(call.call('fs', []), /EBADREQUEST/)
})
