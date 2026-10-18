import assert from 'node:assert/strict'
import { test } from 'node:test'
import { explainMismatch, parseRange, satisfies } from '../src/shared/semver.ts'

test('the M1 plugin range accepts the M1 kernel and rejects M0', () => {
  assert.equal(satisfies('0.2', '>=0.2 <0.3'), true)
  assert.equal(satisfies('0.1', '>=0.2 <0.3'), false)
  assert.equal(satisfies('0.3', '>=0.2 <0.3'), false)
})

test('comparators, caret and tilde', () => {
  assert.equal(satisfies('0.2.5', '>=0.2.1'), true)
  assert.equal(satisfies('0.2.0', '>=0.2.1'), false)
  assert.equal(satisfies('0.2.9', '^0.2.1'), true)
  assert.equal(satisfies('0.3.0', '^0.2.1'), false)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false)
  assert.equal(satisfies('0.2.7', '~0.2.1'), true)
  assert.equal(satisfies('0.3.0', '~0.2.1'), false)
  assert.equal(satisfies('0.2.0', '=0.2.0'), true)
  assert.equal(satisfies('v0.2.0', '0.2.0'), true)
})

test('a malformed range is an error, not a silent accept', () => {
  assert.equal(parseRange('>=0.2 || <0.1'), undefined)
  assert.equal(parseRange('>=x.y'), undefined)
  assert.equal(satisfies('0.2', 'nonsense'), false)
  assert.match(explainMismatch('0.2', 'nonsense'), /not a valid version range/)
})
