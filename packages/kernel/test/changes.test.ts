import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildChangeTree, compareChangeNodes, directoryPaths } from '../src/shared/changes.ts'
import type { ChangeTreeNode, GitStatusEntry } from '../src/shared/types.ts'

/** `buildChangeTree` folds flat status rows into the changes view's tree. */

function entry(file: string, kind: GitStatusEntry['kind'] = 'modified'): GitStatusEntry {
  return { file, kind, status: kind === 'untracked' ? '??' : ' M' }
}

/** Every node's path, depth first (for readable assertions). */
function flatten(node: ChangeTreeNode): string[] {
  const out: string[] = []
  for (const child of node.children ?? []) {
    out.push(child.path)
    if (child.kind === 'dir') out.push(...flatten(child))
  }
  return out
}

test('changes tree: root files and nested files form one tree', () => {
  const tree = buildChangeTree([entry('README.md'), entry('src/app.js'), entry('src/lib/util.ts')])
  assert.equal(tree.count, 3)
  // Directories first, then names.
  assert.deepEqual(
    (tree.children ?? []).map(child => `${child.kind}:${child.path}`),
    ['dir:src', 'file:README.md'],
  )
  // Depth first: the `src` directory's own subdirectories first, then its files.
  assert.deepEqual(flatten(tree), ['src', 'src/lib', 'src/lib/util.ts', 'src/app.js', 'README.md'])
  const src = (tree.children ?? []).find(child => child.path === 'src')
  assert.equal(src?.count, 2)
  const lib = (src?.children ?? []).find(child => child.path === 'src/lib')
  assert.equal(lib?.count, 1)
})

test('changes tree: a single-child directory chain folds into one row', () => {
  const tree = buildChangeTree([entry('a/b/c/file.ts'), entry('x/y.ts')])
  const names = (tree.children ?? []).map(child => child.path)
  // `a/b/c` is one row; `x` keeps its own row (it holds a file, not a dir).
  assert.deepEqual(names, ['a/b/c', 'x'])
  assert.deepEqual(flatten(tree), ['a/b/c', 'a/b/c/file.ts', 'x', 'x/y.ts'])
})

test('changes tree: folding can be turned off', () => {
  const tree = buildChangeTree([entry('a/b/c/file.ts')], { fold: false })
  assert.deepEqual(flatten(tree), ['a', 'a/b', 'a/b/c', 'a/b/c/file.ts'])
})

test('changes tree: a lone file child does not fold away its directory', () => {
  const tree = buildChangeTree([entry('src/only.ts')])
  assert.deepEqual(flatten(tree), ['src', 'src/only.ts'])
  const only = (tree.children ?? [])[0]
  assert.equal(only?.kind, 'dir')
  assert.equal(only?.children?.[0]?.kind, 'file')
})

test('changes tree: entries keep their git row (the badge reads it)', () => {
  const tree = buildChangeTree([entry('new.txt', 'untracked'), entry('gone.txt', 'deleted')])
  const files = (tree.children ?? []).map(child => child.entry)
  assert.deepEqual(files.map(item => `${item?.kind}:${item?.status}`).sort(), ['deleted: M', 'untracked:??'])
})

test('changes tree: an empty status is an empty tree', () => {
  const tree = buildChangeTree([])
  assert.equal(tree.count, 0)
  assert.deepEqual(tree.children, [])
  assert.deepEqual(directoryPaths(tree), [])
})

test('changes tree: directory paths list every dir (the default expanded set)', () => {
  const tree = buildChangeTree([entry('src/a.ts'), entry('docs/guide/x.md')])
  // Folding means `docs/guide` is one row: the expanded set lists what is drawn.
  assert.deepEqual(directoryPaths(tree).sort(), ['docs/guide', 'src'])
})

test('changes tree: ordering is directories first, then case-insensitive names', () => {
  const tree = buildChangeTree([entry('B.md'), entry('a.md'), entry('zz/x.ts')])
  assert.deepEqual((tree.children ?? []).map(child => child.name), ['zz', 'a.md', 'B.md'])
  assert.ok(compareChangeNodes({ kind: 'dir', path: 'd', name: 'd', count: 0 } as ChangeTreeNode, { kind: 'file', path: 'f', name: 'f', count: 1 } as ChangeTreeNode) < 0)
})
