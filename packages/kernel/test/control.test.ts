/**
 * The gateway control plane (contract.md §7): frame rules and the socket
 * transport, server and client ends.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  __testLineBuffer,
  connectControl,
  createControlServer,
  type ControlClient,
  type ControlServer,
} from '../src/server/control.ts'
import {
  controlError,
  frameLine,
  MAX_CONTROL_LINE_BYTES,
  parseRequest,
  requestIdOf,
} from '../src/shared/control.ts'

/** A short socket path (macOS limits a Unix socket path to ~104 bytes). */
function socketPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'di-sock-'))
  return { dir, path: join(dir, 'g.sock') }
}

test('control: request frames are validated (shared/control)', () => {
  assert.deepEqual(parseRequest('{"type":"request","id":7,"method":"ping"}'), {
    type: 'request',
    id: 7,
    method: 'ping',
    params: {},
  })
  for (const bad of [
    'not json',
    '[]',
    '{"type":"event","id":1,"method":"ping"}',
    '{"type":"request","method":"ping"}',
    '{"type":"request","id":1}',
    '{"type":"request","id":1,"method":"ping","params":[1]}',
  ]) {
    assert.throws(() => parseRequest(bad), (error: unknown) => (error as { code?: string }).code === 'EBADREQUEST', bad)
  }
  // A malformed frame still names its id when the JSON has one.
  assert.equal(requestIdOf('{"type":"nope","id":42}'), 42)
  assert.equal(requestIdOf('garbage'), undefined)
})

test('control: errors carry their code prefix; the line limit is 1 MiB', () => {
  const error = controlError('ENOMOUNT', 'mount abc is gone')
  assert.equal(error.code, 'ENOMOUNT')
  assert.equal(error.message, 'ENOMOUNT: mount abc is gone')
  assert.equal(MAX_CONTROL_LINE_BYTES, 1024 * 1024)
  assert.equal(frameLine({ type: 'result', id: 1, result: { ok: true } }), '{"type":"result","id":1,"result":{"ok":true}}')
})

test('control: a request is answered by id; a handler error becomes an error frame', async t => {
  const { dir, path } = socketPath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const server = createControlServer({
    async handle(method, params) {
      if (method === 'ping') return { pong: true, got: params }
      if (method === 'boom') throw controlError('ENOMOUNT', 'no such mount')
      if (method === 'plain') throw new Error('plain failure')
      throw controlError('EMETHOD', `unknown method "${method}"`)
    },
  })
  await server.listen(path)
  t.after(() => server.close())

  const client = await connectControl({ path })
  t.after(() => client.close())
  assert.deepEqual(await client.request('ping', { a: 1 }), { pong: true, got: { a: 1 } })
  await assert.rejects(client.request('boom'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ENOMOUNT')
    assert.equal((error as Error).message, 'ENOMOUNT: no such mount')
    return true
  })
  await assert.rejects(client.request('plain'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'EBADREQUEST')
    assert.equal((error as Error).message, 'EBADREQUEST: plain failure')
    return true
  })
  await assert.rejects(client.request('nope'), (error: unknown) => (error as { code?: string }).code === 'EMETHOD')
})

test('control: one connection has several requests in flight and responses may come out of order', async t => {
  const { dir, path } = socketPath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const server = createControlServer({
    async handle(method, params) {
      const ms = Number(params.ms)
      await delay(ms)
      return { method, ms }
    },
  })
  await server.listen(path)
  t.after(() => server.close())
  const client = await connectControl({ path })
  t.after(() => client.close())

  const slow = client.request('slow', { ms: 60 })
  const fast = client.request('fast', { ms: 1 })
  assert.equal((await fast as { method: string }).method, 'fast') // arrives first
  assert.equal((await slow as { method: string }).method, 'slow')
})

test('control: events reach only connections that subscribed, and only their topics', async t => {
  const { dir, path } = socketPath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let serverRef: ControlServer | undefined
  const server = createControlServer({
    handle(method, params, peer) {
      if (method === 'events') {
        const topics = (params.topics ?? []) as ('mounted' | 'unmounted')[]
        peer.subscribe(topics)
        return { subscribed: true }
      }
      return { method }
    },
  })
  serverRef = server
  await server.listen(path)
  t.after(() => server.close())

  const subscriber = await connectControl({ path })
  t.after(() => subscriber.close())
  const listener = await connectControl({ path })
  t.after(() => listener.close())
  const seen: string[] = []
  const seen2: string[] = []
  subscriber.onEvent((topic, payload) => seen.push(`${topic}:${(payload as { id: string }).id}`))
  listener.onEvent((topic, payload) => seen2.push(`${topic}:${(payload as { id: string }).id}`))

  server.emit('mounted', { id: 'a' }) // nobody subscribed yet
  await subscriber.request('events', { topics: ['mounted'] })
  await listener.request('events', { topics: ['unmounted'] })
  await delay(10)
  serverRef.emit('mounted', { id: 'b' })
  serverRef.emit('unmounted', { id: 'b' })
  await delay(30)
  assert.deepEqual(seen, ['mounted:b'])
  assert.deepEqual(seen2, ['unmounted:b'])
})

test('control: close rejects pending requests; a missing socket is EGATEWAYDEAD', async t => {
  const { dir, path } = socketPath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const server = createControlServer({
    handle: () => new Promise<object>(() => {}), // never answers
  })
  await server.listen(path)
  const client = await connectControl({ path })
  const pending = client.request('hang')
  client.close()
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'EGATEWAYDEAD')
  assert.equal(client.closed, true)
  await server.close()

  await assert.rejects(
    connectControl({ path }),
    (error: unknown) => (error as { code?: string }).code === 'EGATEWAYDEAD',
  )
})

test('control: the line buffer latches over-limit; a frame at the limit is still accepted', () => {
  // The limit is checked after accumulating: 128 × 8192 = 1 MiB is exactly at
  // the limit, the 126 bytes that follow push the line over it.
  const buffer = new __testLineBuffer()
  for (let index = 0; index < 128; index++) {
    assert.equal(buffer.push('x'.repeat(8192)).tooLarge, false, `chunk ${index + 1} is within the limit`)
  }
  assert.equal(buffer.push('x'.repeat(126) + '\n').tooLarge, true)

  const exact = new __testLineBuffer()
  assert.equal(exact.push('y'.repeat(MAX_CONTROL_LINE_BYTES)).tooLarge, false)
  const over = new __testLineBuffer()
  assert.equal(over.push('y'.repeat(MAX_CONTROL_LINE_BYTES + 1)).tooLarge, true)
  // Once over, the connection is gone: every later feed reports the limit.
  assert.equal(over.push('next line\n').tooLarge, true)
})

test('control: a line split across chunks is reassembled, CRLF stripped, several lines per chunk kept', () => {
  const buffer = new __testLineBuffer()
  assert.deepEqual(buffer.push('hel'), { lines: [], tooLarge: false })
  assert.deepEqual(buffer.push('lo\nwor'), { lines: ['hello'], tooLarge: false })
  assert.deepEqual(buffer.push('ld\r\n\nlast'), { lines: ['world'], tooLarge: false })
  assert.deepEqual(buffer.push('\n'), { lines: ['last'], tooLarge: false })
})

test('control: an overlong frame on the wire ends the connection (EGATEWAYDEAD on the client)', async t => {
  const { dir, path } = socketPath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const messages: string[] = []
  const server = createControlServer({ handle: () => ({ ok: true }), log: message => messages.push(message) })
  await server.listen(path)
  t.after(() => server.close())
  const client = await connectControl({ path, log: () => {} })
  t.after(() => client.close())
  // A request whose *JSON line* exceeds 1 MiB: the server drops the connection.
  // (Bytes are learned in 8 KiB reads, so the check trips on a later chunk.)
  await assert.rejects(
    client.request('echo', { huge: 'x'.repeat(MAX_CONTROL_LINE_BYTES + 4096) }),
    (error: unknown) => (error as { code?: string }).code === 'EGATEWAYDEAD',
  )
  assert.ok(messages.some(message => message.includes('above')), messages.join('\n'))
})

test('control: a second listener on the same path is EADDRINUSE (whoever binds first wins)', async t => {
  const { dir, path } = socketPath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = createControlServer({ handle: () => ({}) })
  await first.listen(path)
  t.after(() => first.close())
  const second = createControlServer({ handle: () => ({}) })
  await assert.rejects(second.listen(path), (error: unknown) => (error as { code?: string }).code === 'EADDRINUSE')
})

test('control: closed lines split across chunks are reassembled', async t => {
  const { dir, path } = socketPath()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen: string[] = []
  const server = createControlServer({
    handle(_method, params) {
      seen.push(String(params.text))
      return { ok: true }
    },
  })
  await server.listen(path)
  t.after(() => server.close())
  const client = await connectControl({ path })
  t.after(() => client.close())
  // One frame written as two socket writes (the line buffer must hold the rest).
  const { connect } = await import('node:net')
  const raw = connect(path)
  await new Promise<void>(done => raw.once('connect', () => done()))
  const frame = '{"type":"request","id":1,"method":"echo","params":{"text":"héllo"}}\n'
  raw.write(frame.slice(0, 20))
  await delay(10)
  raw.write(frame.slice(20))
  await delay(50)
  raw.destroy()
  assert.deepEqual(seen, ['héllo'])
})
