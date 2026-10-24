import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  readFolded,
  SIDEBAR_FOLDED_KEY,
  SIDEBAR_RAIL_PX,
  storeFolded,
} from '../src/sidebar.ts'

/**
 * Folding the left column (docs/m18/spec.md, contract.md §5.2): the state is a
 * preference, so the interesting cases are all about storage — what a page with
 * no storage does, and what a value written by somebody else means.
 *
 * Node has no `localStorage` (a page API), so the tests install a Map-backed
 * one. The module reads `globalThis.localStorage` at call time, exactly so a
 * page without it degrades instead of throwing (the same shape as
 * `diorama-ui/splitpane`).
 */
class MemoryStorage {
  private readonly items = new Map<string, string>()
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
  clear(): void {
    this.items.clear()
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })

test('readFolded: nothing stored means the column is open', () => {
  storage.clear()
  assert.equal(readFolded(), false)
})

test('storeFolded: a folded column comes back folded', () => {
  storage.clear()
  storeFolded(true)
  assert.equal(readFolded(), true)
  assert.equal(globalThis.localStorage?.getItem(SIDEBAR_FOLDED_KEY), '1')
})

test('storeFolded: unfolding is written too, so a reload does not fold again', () => {
  storage.clear()
  storeFolded(true)
  storeFolded(false)
  assert.equal(readFolded(), false)
})

test('readFolded: a value written by somebody else leaves the column open', () => {
  // "Fold on a truthy value" would fold the column on 'false', '0' or a stray
  // 'yes': a folded column is the surprising state to come back to, so only the
  // exact stored value counts.
  for (const value of ['false', '0', 'yes', '', 'TRUE']) {
    storage.clear()
    globalThis.localStorage?.setItem(SIDEBAR_FOLDED_KEY, value)
    assert.equal(readFolded(), false, '"' + value + '" must not fold the column')
  }
})

test('a page with no storage is open, and remembering is not a failure', () => {
  const original = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })
  try {
    assert.equal(readFolded(), false)
    storeFolded(true)
    assert.equal(readFolded(), false)
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true })
  }
})

test('the folded column keeps the switcher: a rail is wider than nothing', () => {
  // A zero-width fold would take the unfold button with it (contract.md §5.2).
  assert.equal(SIDEBAR_RAIL_PX > 0, true)
  assert.equal(SIDEBAR_RAIL_PX <= 48, true)
})
