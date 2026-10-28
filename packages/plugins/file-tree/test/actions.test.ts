import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actionUrl,
  FILE_ACTIONS,
  fileCommand,
  runFileAction,
  withDownload,
  type FileActionHost,
} from '../src/actions.ts'

/**
 * The three file actions (contract.md §36): one URL, three things the browser
 * can be asked to do with it.
 *
 * `actions.ts` imports nothing on purpose (see its header): a new module that
 * imports the kernel without also importing `cordis` drops the `Context.provide`
 * augmentation for the package. That is why the URL is a parameter here.
 */

const URL = 'http://127.0.0.1:1234/~raw~/src/app.js'

/** A host that records what it was asked to do. */
function host(overrides: Partial<FileActionHost> = {}): FileActionHost & { saved: string[]; copied: string[]; opened: string[] } {
  const saved: string[] = []
  const copied: string[] = []
  const opened: string[] = []
  return {
    saved,
    copied,
    opened,
    save: url => void saved.push(url),
    copy: async text => {
      copied.push(text)
      return true
    },
    open: url => {
      opened.push(url)
      return true
    },
    ...overrides,
  }
}

test('the three actions are download, copy the link, open a window', () => {
  assert.deepEqual(
    FILE_ACTIONS.map(action => action.id),
    ['download', 'copyLink', 'openInWindow'],
  )
  // Every row says what it does, and every command id is namespaced.
  for (const action of FILE_ACTIONS) {
    assert.notEqual(action.label, '')
    assert.notEqual(action.hint, '')
    assert.equal(fileCommand(action.id), `file.${action.id}`)
  }
})

test('withDownload appends to the query, never replaces it', () => {
  assert.equal(withDownload(URL), `${URL}?download=1`)
  // A URL that already has a query keeps it (the raw route has none today, but
  // the helper must not be the thing that silently drops one).
  assert.equal(withDownload(`${URL}?x=1`), `${URL}?x=1&download=1`)
})

test('only the download action changes the URL', () => {
  assert.equal(actionUrl('download', URL), `${URL}?download=1`)
  assert.equal(actionUrl('copyLink', URL), URL)
  assert.equal(actionUrl('openInWindow', URL), URL)
})

test('download hands the attachment URL to the browser', async () => {
  const h = host()
  const outcome = await runFileAction('download', URL, h)
  assert.equal(outcome.ok, true)
  assert.deepEqual(h.saved, [`${URL}?download=1`])
  // Saving is a navigation: nothing else is touched.
  assert.deepEqual(h.copied, [])
  assert.deepEqual(h.opened, [])
})

test('copying the link copies the raw URL itself', async () => {
  const h = host()
  const outcome = await runFileAction('copyLink', URL, h)
  assert.equal(outcome.ok, true)
  assert.deepEqual(h.copied, [URL])
  assert.deepEqual(h.saved, [])
})

test('opening a window opens the raw URL itself', async () => {
  const h = host()
  const outcome = await runFileAction('openInWindow', URL, h)
  assert.equal(outcome.ok, true)
  assert.deepEqual(h.opened, [URL])
})

test('a refused clipboard reports the URL rather than failing silently', async () => {
  const h = host({ copy: async () => false })
  const outcome = await runFileAction('copyLink', URL, h)
  assert.equal(outcome.ok, false)
  // The address is what the reader wanted: it is in the message they can copy.
  assert.ok(outcome.message?.includes(URL) === true)
  assert.equal(outcome.url, URL)
})

test('a blocked window reports the URL rather than failing silently', async () => {
  const h = host({ open: () => false })
  const outcome = await runFileAction('openInWindow', URL, h)
  assert.equal(outcome.ok, false)
  assert.ok(outcome.message?.includes(URL) === true)
  assert.equal(outcome.url, URL)
})
