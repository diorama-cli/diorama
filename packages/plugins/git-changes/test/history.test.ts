import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyHashValue, parseHistoryHash, pickCommits } from '../src/history.ts'

/**
 * The history view's hash value (contract.md §3.8) and what a click does to
 * the pick (v0.25). Both are pure functions, so they are tested here rather
 * than through the page: the page's e2e can only show the result.
 *
 * The list is drawn **newest first**: `order` below is `['n', 'm', 'o']`
 * (n = newest, o = oldest), so the answers come back oldest → newest.
 */

test('history hash: one commit is the value v0.6–v0.24 wrote', () => {
  assert.equal(historyHashValue('', ['abc123']), 'abc123')
  assert.equal(historyHashValue('apps/web', ['abc123']), 'apps/web:abc123')
  // The single-commit decode has no `commits` key: nothing downstream has to
  // know that a pick of several exists.
  assert.deepEqual(parseHistoryHash('abc123'), { repo: '', commit: 'abc123' })
  assert.deepEqual(parseHistoryHash('apps/web:abc123'), { repo: 'apps/web', commit: 'abc123' })
})

test('history hash: several commits are written oldest first, newest last', () => {
  const value = historyHashValue('', ['old', 'mid', 'new'])
  assert.equal(value, 'old,mid,new')
  assert.deepEqual(parseHistoryHash(value), { repo: '', commit: 'new', commits: ['old', 'mid', 'new'] })
  // A repository path keeps its slashes; only the first `:` separates.
  assert.equal(historyHashValue('apps/web', ['a', 'b']), 'apps/web:a,b')
  assert.deepEqual(parseHistoryHash('apps/web:a,b'), { repo: 'apps/web', commit: 'b', commits: ['a', 'b'] })
})

test('history hash: empty and malformed values pick nothing', () => {
  assert.equal(parseHistoryHash(undefined), undefined)
  assert.equal(parseHistoryHash(''), undefined)
  // An empty commit list (a stray comma) is not a pick.
  assert.equal(parseHistoryHash(':'), undefined)
  assert.equal(parseHistoryHash('apps/web:'), undefined)
})

test('pick: a plain click replaces the pick with that one row', () => {
  assert.deepEqual(pickCommits([], undefined, 'm', ['n', 'm', 'o']), { commits: ['m'], anchor: 'm' })
  assert.deepEqual(pickCommits(['o', 'n'], 'n', 'm', ['n', 'm', 'o']), { commits: ['m'], anchor: 'm' })
})

test('pick: Shift picks the whole stretch, both ends included', () => {
  // From the newest down to the oldest: everything in between is picked too.
  assert.deepEqual(pickCommits(['n'], 'n', 'o', ['n', 'm', 'o'], { shift: true }), {
    commits: ['o', 'm', 'n'],
    anchor: 'n',
  })
  // …and upwards from an older anchor gives the same stretch.
  assert.deepEqual(pickCommits(['o'], 'o', 'n', ['n', 'm', 'o'], { shift: true }), {
    commits: ['o', 'm', 'n'],
    anchor: 'o',
  })
  // The anchor stays put, so a second Shift-click grows from the same end.
  const first = pickCommits(['n'], 'n', 'm', ['n', 'm', 'o'], { shift: true })
  assert.deepEqual(pickCommits(first.commits, first.anchor, 'o', ['n', 'm', 'o'], { shift: true }), {
    commits: ['o', 'm', 'n'],
    anchor: 'n',
  })
})

test('pick: Shift without an anchor is an ordinary click', () => {
  assert.deepEqual(pickCommits([], undefined, 'm', ['n', 'm', 'o'], { shift: true }), { commits: ['m'], anchor: 'm' })
})

test('pick: ⌘ / Ctrl adds a row, and takes a picked one out again', () => {
  assert.deepEqual(pickCommits(['n'], 'n', 'o', ['n', 'm', 'o'], { toggle: true }), {
    commits: ['o', 'n'],
    anchor: 'o',
  })
  assert.deepEqual(pickCommits(['o', 'n'], 'o', 'n', ['n', 'm', 'o'], { toggle: true }), {
    commits: ['o'],
    anchor: 'n',
  })
  // Taking the last one out leaves nothing picked, and that is a state.
  assert.deepEqual(pickCommits(['n'], 'n', 'n', ['n', 'm', 'o'], { toggle: true }), {
    commits: [],
    anchor: 'n',
  })
})
