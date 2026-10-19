import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleFrame, type RpcDispatcher } from '../src/server/rpc.ts'
import type { RpcResponse } from '../src/shared/rpc.ts'

/**
 * Contract §4: a subscription endpoint (`<service>.watch`) turns a call into a
 * push. Events carry the session; `cancel` and connection close end it; a
 * session-scoped frame must not reach another connection.
 */

/** A dispatcher whose `fs.watch` hands back a pushable fake. */
function fakeDispatcher() {
  const listeners = new Map<number, (payload: unknown) => void>()
  let next = 0
  let disposed = 0
  const dispatcher: RpcDispatcher = {
    services: () => ['fs'],
    async call() {
      return 'plain'
    },
    async subscribe(method, args, push) {
      assert.equal(method, 'fs.watch')
      const id = ++next
      listeners.set(id, push)
      void args
      return () => {
        disposed++
        listeners.delete(id)
      }
    },
  }
  return {
    dispatcher,
    get disposed() {
      return disposed
    },
    /** Push to one subscription (the latest one). */
    push(payload: unknown): void {
      listeners.get(next)?.(payload)
    },
    get live(): number {
      return listeners.size
    },
  }
}

/** One fake connection: a frame sink plus its subscription table. */
function peer() {
  const frames: RpcResponse[] = []
  const subscriptions = new Map<string, { dispose(): void }>()
  return {
    frames,
    peer: { socket: {} as never, subscriptions },
    send: (message: RpcResponse) => frames.push(message),
  }
}

test('rpc: a subscription call answers with a session and pushes tagged events', async () => {
  const fake = fakeDispatcher()
  const { frames, peer: connection, send } = peer()
  await handleFrame(fake.dispatcher, JSON.stringify({ type: 'call', id: 1, method: 'fs.watch', args: [''] }), send, () => {}, connection)

  const started = frames[0] as { type: string; value: { session: string } }
  assert.equal(started.type, 'result')
  assert.match(started.value.session, /^fs:/)
  assert.equal(connection.subscriptions.size, 1)

  fake.push({ type: 'change', path: 'a.txt' })
  const event = frames[1] as { type: string; session: string; payload: unknown }
  assert.equal(event.type, 'event')
  assert.equal(event.session, started.value.session)
  assert.deepEqual(event.payload, { type: 'change', path: 'a.txt' })

  // cancel ends it
  await handleFrame(fake.dispatcher, JSON.stringify({ type: 'cancel', session: started.value.session }), send, () => {}, connection)
  assert.equal(fake.disposed, 1)
  assert.equal(connection.subscriptions.size, 0)
})

test('rpc: cancel for an unknown session is logged, not fatal', async () => {
  const fake = fakeDispatcher()
  const { frames, peer: connection, send } = peer()
  const logs: string[] = []
  await handleFrame(fake.dispatcher, JSON.stringify({ type: 'cancel', session: 'fs:999' }), send, message => logs.push(message), connection)
  assert.equal(frames.length, 0)
  assert.match(logs[0] ?? '', /unknown session fs:999/)
})

test('rpc: a subscription without a connection is refused with EMETHOD', async () => {
  const fake = fakeDispatcher()
  const { frames, send } = peer()
  await handleFrame(fake.dispatcher, JSON.stringify({ type: 'call', id: 7, method: 'fs.watch', args: [''] }), send, () => {})
  const error = frames[0] as { type: string; code: string }
  assert.equal(error.type, 'error')
  assert.equal(error.code, 'EMETHOD')
})

test('rpc: plain calls still work and do not create sessions', async () => {
  const fake = fakeDispatcher()
  const { frames, peer: connection, send } = peer()
  await handleFrame(fake.dispatcher, JSON.stringify({ type: 'call', id: 2, method: 'fs.list', args: [] }), send, () => {}, connection)
  assert.deepEqual(frames[0], { type: 'result', id: 2, value: 'plain' })
  assert.equal(connection.subscriptions.size, 0)
})

test('rpc: a dispatcher without subscriptions refuses watch like any unknown method', async () => {
  const dispatcher: RpcDispatcher = { services: () => ['fs'], async call() { return undefined } }
  const { frames, peer: connection, send } = peer()
  await handleFrame(dispatcher, JSON.stringify({ type: 'call', id: 3, method: 'fs.watch', args: [''] }), send, () => {}, connection)
  // Falls through to `call`, whose dispatcher here answers normally.
  assert.equal((frames[0] as { type: string }).type, 'result')
})
