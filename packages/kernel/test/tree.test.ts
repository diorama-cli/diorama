import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ancestorsOf, createTreeService } from '../src/client/tree.ts'
import type { FileInfo } from '../src/shared/types.ts'

function file(path: string): FileInfo {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: 1, mtime: 0 }
}

test('tree: reveal expands the way to the file and stamps the request', () => {
  const tree = createTreeService()
  tree.reveal('docs/guides/deep/readme.md')
  const first = tree.getSnapshot()
  // Every directory between the root and the file is open — the row is inside
  // them, and a collapsed parent has no row to scroll to (contract.md §35).
  assert.deepEqual(first.expanded, ['docs', 'docs/guides', 'docs/guides/deep'])
  assert.deepEqual(first.reveal, { path: 'docs/guides/deep/readme.md', at: 1 })
  // Locating is not navigating: nothing is selected, nothing is opened.
  assert.equal(first.selected, undefined)

  // A second press for the same file is a second request: the stamp moves, so
  // a view that only listened for the path would not scroll again.
  tree.reveal('docs/guides/deep/readme.md')
  const second = tree.getSnapshot()
  assert.equal(second.reveal?.at, 2)
  assert.deepEqual(second.expanded, first.expanded)
  assert.notEqual(second, first)
})

test('tree: reveal keeps directories the reader opened, and does not close any', () => {
  const tree = createTreeService()
  tree.toggle('src')
  tree.toggle('vendor')
  tree.reveal('src/app.ts')
  assert.deepEqual(tree.getSnapshot().expanded, ['src', 'vendor'])
  // A file at the root has no ancestor to expand.
  tree.reveal('README.md')
  assert.deepEqual(tree.getSnapshot().expanded, ['src', 'vendor'])
  assert.equal(tree.getSnapshot().reveal?.path, 'README.md')
})

test('tree: ancestorsOf lists every directory on the way, root entries none', () => {
  assert.deepEqual(ancestorsOf('README.md'), [])
  assert.deepEqual(ancestorsOf('src/app.ts'), ['src'])
  assert.deepEqual(ancestorsOf('a/b/c/d.md'), ['a', 'a/b', 'a/b/c'])
  // A trailing slash (a directory path) does not add an empty segment.
  assert.deepEqual(ancestorsOf('a/b/'), ['a'])
})

test('tree: select still opens the file and notifies the opener', () => {
  const tree = createTreeService()
  const opened: string[] = []
  const off = tree.onSelect(entry => opened.push(entry.path))
  tree.select(file('src/app.ts'))
  tree.select(file('src/app.ts'))
  off()
  tree.select(file('other.ts'))
  assert.deepEqual(opened, ['src/app.ts', 'src/app.ts'])
  assert.equal(tree.getSnapshot().selected, 'other.ts')
})
