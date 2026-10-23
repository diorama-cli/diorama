import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clampPane,
  MAX_PANE_PX,
  MIN_PANE_PX,
  readPaneSize,
  storePaneSize,
} from '../src/splitpane.ts'

/**
 * A draggable pane's width (docs/m15/spec.md, contract.md §5.2): the bounds are
 * one set for every pane, a stored width is clamped rather than thrown away,
 * and an unreadable storage is never a throw.
 *
 * Node has no `localStorage` (it is a page API), so the tests install a
 * `Map`-backed one: the module reads `globalThis.localStorage` at call time
 * precisely so that a page without it (an embedded host) degrades instead of
 * throwing, and that is what the last test checks.
 */
class MemoryStorage {
  private readonly items = new Map<string, string>()
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })

test('clampPane: a width outside the bounds is pulled back to them', () => {
  assert.equal(clampPane(10), MIN_PANE_PX)
  assert.equal(clampPane(5000), MAX_PANE_PX)
  assert.equal(clampPane(320), 320)
  // Fractional pointer positions round: a CSS pixel is the unit.
  assert.equal(clampPane(320.6), 321)
})

test('clampPane: a pane can bring its own bounds', () => {
  assert.equal(clampPane(100, 200, 400), 200)
  assert.equal(clampPane(900, 200, 400), 400)
})

test('clampPane: a value that is not a number is the minimum, never NaN', () => {
  assert.equal(clampPane(Number.NaN), MIN_PANE_PX)
  // A boundless number is still a number: it clamps like any other.
  assert.equal(clampPane(Number.POSITIVE_INFINITY), MAX_PANE_PX)
  assert.equal(clampPane(Number.NEGATIVE_INFINITY), MIN_PANE_PX)
})

test('readPaneSize: nothing stored means the caller\'s fallback', () => {
  assert.equal(readPaneSize('diorama.test.missing', 300), 300)
})

test('readPaneSize: a stored width comes back, clamped', () => {
  storePaneSize('diorama.test.pane', 340)
  assert.equal(readPaneSize('diorama.test.pane', 260), 340)
  storePaneSize('diorama.test.pane', 99999)
  assert.equal(readPaneSize('diorama.test.pane', 260), MAX_PANE_PX)
})

test('readPaneSize: a stored value that is not a number falls back', () => {
  storePaneSize('diorama.test.pane', 0)
  globalThis.localStorage?.setItem('diorama.test.pane', 'wide')
  assert.equal(readPaneSize('diorama.test.pane', 260), 260)
})

test('storePaneSize: no storage at all is not a failure', () => {
  const original = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })
  try {
    storePaneSize('diorama.test.pane', 300)
    assert.equal(readPaneSize('diorama.test.pane', 280), 280)
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true })
  }
})
