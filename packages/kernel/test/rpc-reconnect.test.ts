import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRpcClient, type RpcClient } from '../src/client/rpc.ts'
import type { RpcResponse } from '../src/shared/rpc.ts'

/**
 * Contract §4, the client side: a dropped connection is not the end of the
 * page. The channel dials again, replays every subscription endpoint (the
 * server ended them when the old socket closed) and tells the page through
 * `onReconnect`; an idle socket that stops answering is treated as dropped.
 *
 * The transport is faked: what is under test is the state machine, not the
 * browser's WebSocket.
 */

/** One fake connection, driven by the test. */
class FakeSocket {
  static readonly all: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  readonly sent: string[] = []

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send on a closed socket')
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  /** Deliver one frame from the server. */
  receive(message: RpcResponse): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  /** The frames of one type, parsed. */
  frames(type: string): Record<string, unknown>[] {
    return this.sent.map(raw => JSON.parse(raw) as Record<string, unknown>).filter(frame => frame.type === type)
  }
}

/** Wait until `predicate` holds (or fail). */
async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for the channel')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function channel(overrides: { heartbeat?: { everyMs?: number; timeoutMs?: number } } = {}): { client: RpcClient; sockets: FakeSocket[] } {
  FakeSocket.all.length = 0
  const client = createRpcClient({
    url: 'ws://127.0.0.1:1/__diorama__/rpc',
    connect: () => new FakeSocket('ws://127.0.0.1:1/__diorama__/rpc') as unknown as WebSocket,
    log: () => {},
    retry: { initialMs: 5, maxMs: 10 },
    heartbeat: overrides.heartbeat ?? { everyMs: 60_000, timeoutMs: 120_000 },
  })
  return { client, sockets: FakeSocket.all }
}

test('rpc client: calls go out once the socket opens', async t => {
  const { client, sockets } = channel()
  t.after(() => client.close())
  const first = sockets[0]!
  first.open()
  const pending = client.call('fs.list', '')
  const call = first.frames('call')[0]!
  assert.equal(call.method, 'fs.list')
  assert.deepEqual(call.args, [''])
  first.receive({ type: 'result', id: call.id as number, value: ['a'] })
  assert.deepEqual(await pending, ['a'])
})

test('rpc client: a dropped socket reconnects and replays its subscriptions', async t => {
  const { client, sockets } = channel()
  t.after(() => client.close())
  let reconnects = 0
  client.onReconnect(() => reconnects++)
  const events: unknown[] = []
  const stop = client.watchEndpoint('fs.watch', [''], payload => events.push(payload))

  const first = sockets[0]!
  first.open()
  await until(() => first.frames('call').length === 1)
  first.receive({ type: 'result', id: first.frames('call')[0]!.id as number, value: { session: 'fs:1' } })
  // The listener is registered once the session is known (a microtask); frames
  // arrive in later tasks, as they do over a real socket.
  await new Promise(resolve => setTimeout(resolve, 0))
  first.receive({ type: 'event', topic: 'fs:1', session: 'fs:1', payload: { type: 'change', path: 'a.txt' } })
  assert.deepEqual(events, [{ type: 'change', path: 'a.txt' }])
  assert.equal(reconnects, 0, 'the first connect is not a reconnect')

  // The network goes away: the socket closes and the channel dials again.
  first.close()
  await until(() => sockets.length === 2)
  const second = sockets[1]!
  second.open()
  assert.equal(reconnects, 1)
  // The endpoint is started again on the new connection, with a new session.
  await until(() => second.frames('call').length === 1)
  assert.equal(second.frames('call')[0]!.method, 'fs.watch')
  second.receive({ type: 'result', id: second.frames('call')[0]!.id as number, value: { session: 'fs:2' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  second.receive({ type: 'event', topic: 'fs:2', session: 'fs:2', payload: { type: 'change', path: 'b.txt' } })
  assert.deepEqual(events.at(-1), { type: 'change', path: 'b.txt' })

  // Unsubscribing ends the session on the live connection.
  stop()
  assert.deepEqual(second.frames('cancel')[0], { type: 'cancel', session: 'fs:2' })
})

test('rpc client: calls during an outage fail loud instead of hanging', async t => {
  const { client, sockets } = channel()
  t.after(() => client.close())
  sockets[0]!.open()
  sockets[0]!.close()
  await assert.rejects(client.call('fs.list', ''), /EDISCONNECTED/)
})

test('rpc client: a silent socket is dropped and dialed again', async t => {
  const { client, sockets } = channel({ heartbeat: { everyMs: 10, timeoutMs: 30 } })
  t.after(() => client.close())
  sockets[0]!.open()
  // Nobody answers: the channel pings, hears nothing, and gives up on it.
  await until(() => sockets.length >= 2, 3000)
  assert.ok(sockets[0]!.frames('ping').length > 0, 'the page keeps the connection alive with pings')
})

test('rpc client: close() stops the channel for good', async t => {
  const { client, sockets } = channel()
  t.after(() => client.close())
  sockets[0]!.open()
  client.close()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(sockets.length, 1, 'a closed channel does not dial again')
})
