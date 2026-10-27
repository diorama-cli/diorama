/**
 * The page's `<title>` names the served directory (contract.md §34): the shell
 * is static HTML and the root is server-side knowledge, so the two meet in
 * `serveShell` — these are the rules it follows.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shellTitle, withShellTitle } from '../src/server/shell-title.ts'

const shell = '<!doctype html><html><head><title>diorama</title></head><body></body></html>'

test('shell title: the mount root names the page', () => {
  assert.equal(shellTitle('/Users/joe/code/diorama'), 'diorama')
  // A trailing separator belongs to the path, not to the directory's name.
  assert.equal(shellTitle('/Users/joe/code/diorama/'), 'diorama')
  // Nothing to name: the filesystem root has no name of its own.
  assert.equal(shellTitle('/'), '')
})

test('shell title: the shell keeps its title when the root names nothing', () => {
  assert.equal(withShellTitle(shell, '/'), shell)
  // A shell without a <title> is served as it is rather than gaining one.
  assert.equal(withShellTitle('<head></head>', '/tmp/project'), '<head></head>')
})

test('shell title: the shell\'s own title is replaced and nothing else moves', () => {
  assert.equal(
    withShellTitle(shell, '/tmp/my-project'),
    '<!doctype html><html><head><title>my-project</title></head><body></body></html>',
  )
})

test('shell title: markup in a directory name is text, not markup', () => {
  assert.equal(shellTitle('/tmp/<script>'), '<script>')
  assert.equal(
    withShellTitle(shell, '/tmp/<script>'),
    '<!doctype html><html><head><title>&lt;script&gt;</title></head><body></body></html>',
  )
})
