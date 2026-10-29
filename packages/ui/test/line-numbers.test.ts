/**
 * The `:line` suffix and the gutter's state (contract.md §3.11).
 *
 * Pure functions plus a store that reads `localStorage` **at call time**, so a
 * `node --test` run installs a `Map`-backed one (Node has no storage) and the
 * rules are pinned without a browser — the same shape as `splitpane.test.ts`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampTarget,
  formatLineSpec,
  LINE_NUMBERS_STORAGE_KEY,
  lineNumbersShown,
  lineNumbersStore,
  parseLineSpec,
  setLineNumbers,
  splitLineSuffix,
  toggleLineNumbers,
} from '../src/line-numbers.ts'

/** Node has no `localStorage`: install one the module can find. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
  })
  return store
}

/** Forget the page global so the next read starts from storage again. */
function resetPage(): void {
  delete (globalThis as { __diorama_line_numbers__?: unknown }).__diorama_line_numbers__
}

test('parseLineSpec: one line, a range, a range written backwards', () => {
  assert.deepEqual(parseLineSpec('42'), { start: 42, end: 42 })
  assert.deepEqual(parseLineSpec('42-60'), { start: 42, end: 60 })
  assert.deepEqual(parseLineSpec('60-42'), { start: 42, end: 60 })
  assert.deepEqual(parseLineSpec(' 7 '), { start: 7, end: 7 })
  assert.deepEqual(parseLineSpec('3 - 9'), { start: 3, end: 9 })
})

test('parseLineSpec: anything that is not a line is not a suffix', () => {
  assert.equal(parseLineSpec(''), undefined)
  assert.equal(parseLineSpec('0'), undefined)
  assert.equal(parseLineSpec('0-5'), undefined)
  assert.equal(parseLineSpec('a'), undefined)
  assert.equal(parseLineSpec('42a'), undefined)
  assert.equal(parseLineSpec('42-'), undefined)
  assert.equal(parseLineSpec('-42'), undefined)
  assert.equal(parseLineSpec('1.5'), undefined)
})

test('splitLineSuffix: the last colon, and only when a line follows it', () => {
  assert.deepEqual(splitLineSuffix('src/app.ts:42'), { path: 'src/app.ts', target: { start: 42, end: 42 } })
  assert.deepEqual(splitLineSuffix('src/app.ts:42-60'), { path: 'src/app.ts', target: { start: 42, end: 60 } })
  // No line: the whole text stays the file name, colons included.
  assert.deepEqual(splitLineSuffix('src/app.ts'), { path: 'src/app.ts', target: undefined })
  assert.deepEqual(splitLineSuffix('src/app.ts:'), { path: 'src/app.ts:', target: undefined })
  assert.deepEqual(splitLineSuffix('weird:name.ts'), { path: 'weird:name.ts', target: undefined })
  // The *last* colon separates, so a colon inside the path is kept.
  assert.deepEqual(splitLineSuffix('a:b.ts:12'), { path: 'a:b.ts', target: { start: 12, end: 12 } })
  // Nothing typed yet is the empty query, not a file named "".
  assert.deepEqual(splitLineSuffix(''), { path: '', target: undefined })
})

test('clampTarget: both ends land inside the file', () => {
  assert.deepEqual(clampTarget({ start: 999, end: 999 }, 10), { start: 10, end: 10 })
  assert.deepEqual(clampTarget({ start: 8, end: 999 }, 10), { start: 8, end: 10 })
  assert.deepEqual(clampTarget({ start: 3, end: 5 }, 10), { start: 3, end: 5 })
  // An empty file still has a line 1 to point at.
  assert.deepEqual(clampTarget({ start: 4, end: 4 }, 0), { start: 1, end: 1 })
})

test('formatLineSpec: one line prints bare, a range prints both ends', () => {
  assert.equal(formatLineSpec({ start: 42, end: 42 }), '42')
  assert.equal(formatLineSpec({ start: 42, end: 60 }), '42-60')
})

test('line numbers: default on, the choice is remembered, subscribers hear it once', () => {
  const storage = installStorage()
  resetPage()
  let heard = 0
  const off = lineNumbersStore.subscribe(() => {
    heard++
  })
  try {
    assert.equal(lineNumbersShown(), true, 'nobody has chosen yet: the gutter is on')
    assert.equal(lineNumbersStore.getSnapshot(), true)

    assert.equal(toggleLineNumbers(), false)
    assert.equal(lineNumbersShown(), false)
    assert.equal(storage.get(LINE_NUMBERS_STORAGE_KEY), '0')
    assert.equal(heard, 1)

    // Setting the same value again changes nothing and notifies nobody.
    setLineNumbers(false)
    assert.equal(heard, 1)

    // A fresh page (a reload) starts from what was remembered.
    resetPage()
    assert.equal(lineNumbersShown(), false)

    setLineNumbers(true)
    assert.equal(storage.get(LINE_NUMBERS_STORAGE_KEY), '1')
    resetPage()
    assert.equal(lineNumbersShown(), true)
  } finally {
    off()
  }
})

test('line numbers: a blocked storage falls back to the default instead of throwing', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked')
    },
  })
  resetPage()
  try {
    assert.equal(lineNumbersShown(), true)
    assert.doesNotThrow(() => setLineNumbers(false))
    assert.equal(lineNumbersShown(), false)
  } finally {
    installStorage()
    resetPage()
  }
})
