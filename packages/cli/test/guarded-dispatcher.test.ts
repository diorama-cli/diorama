import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardedDispatcher } from '../src/gateway.ts'

/**
 * Failure attribution (contract.md §11): a mount degrades for a fault, not for
 * an answer. A file that vanished while the page was open (`ENOENT`) or a
 * binary that was read once (`EBINARY`) is an answer to a request.
 */
function mount(
  handler: (method: string) => Promise<unknown>,
): {
  dispatcher: ReturnType<typeof guardedDispatcher>
  events: string[]
} {
  const events: string[] = []
  const inner = {
    services: () => ['fs', 'git'],
    call: (method: string) => handler(method),
  }
  const dispatcher = guardedDispatcher('m1', inner as never, {
    degrade: id => {
      events.push(`degrade:${id}`)
      return undefined
    },
    recover: id => {
      events.push(`recover:${id}`)
      return undefined
    },
  })
  return { dispatcher, events }
}

function coded(code: string): Promise<never> {
  const error = new Error(`${code}: simulated`) as Error & { code: string }
  error.code = code
  return Promise.reject(error)
}

test('guarded dispatcher: answer codes fail the request but never degrade the mount', async () => {
  for (const code of ['ENOENT', 'EBINARY', 'ETOOLARGE', 'EINVAL', 'EOUTSIDE', 'ENOTREPO', 'ESERVICE', 'EMETHOD', 'EDISCONNECTED']) {
    const { dispatcher, events } = mount(() => coded(code))
    await assert.rejects(dispatcher.call('fs.readText', ['gone.txt']))
    assert.deepEqual(events, [], `${code} must not be reported as a mount fault`)
  }
})

test('guarded dispatcher: a failure without a code degrades the mount', async () => {
  const { dispatcher, events } = mount(() => Promise.reject(new Error('the service crashed')))
  await assert.rejects(dispatcher.call('git.status', []), /crashed/)
  assert.deepEqual(events, ['degrade:m1'])
})

test('guarded dispatcher: an unknown code degrades, and the next success recovers', async () => {
  const codes = ['EBROKEN']
  const { dispatcher, events } = mount(() => (codes.length > 0 ? coded(codes.pop() as string) : Promise.resolve('ok')))
  await assert.rejects(dispatcher.call('git.status', []))
  assert.deepEqual(events, ['degrade:m1'])
  assert.equal(await dispatcher.call('git.status', []), 'ok')
  assert.deepEqual(events, ['degrade:m1', 'recover:m1'])
})
