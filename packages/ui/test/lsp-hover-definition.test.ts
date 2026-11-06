/**
 * What a ⌘/Ctrl+click on a symbol means (contract.md §3.12).
 *
 * The rule that was wrong the first time: **the place the reader clicked is
 * dropped** before deciding. Without it a click on a declaration answers "you
 * are already here" and highlights itself, and a click on a usage never shows
 * the other usages.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseTargets, describePlace, isSelf, type DefinitionPlace } from '../src/definition-list.ts'
import { wordTextAt } from '../src/lsp-position.ts'

const place = (line: number, path = 'a.ts', endLine?: number): DefinitionPlace =>
  endLine === undefined ? { path, line, character: 0 } : { path, line, character: 0, endLine }

const HERE = { path: 'a.ts', line: 5, character: 4 }

test('isSelf: the clicked line is here, a range that spans it is here too', () => {
  assert.equal(isSelf(place(5), HERE), true)
  assert.equal(isSelf(place(4, 'a.ts', 9), HERE), true, 'a declaration whose body covers the click')
  assert.equal(isSelf(place(6), HERE), false)
  assert.equal(isSelf(place(5, 'b.ts'), HERE), false)
})

test('clicking a usage leaves the declaration', () => {
  const choice = chooseTargets([place(2)], [place(2), place(5)], HERE)
  assert.equal(choice.kind, 'jump')
  if (choice.kind !== 'jump') return
  assert.equal(choice.target.line, 2)
  assert.equal(choice.target.kind, 'definition')
})

test('clicking a declaration leaves the usages, not itself', () => {
  // Declared on line 2; used on 5 and 9; the reader clicked line 2.
  const here = { path: 'a.ts', line: 2, character: 16 }
  const choice = chooseTargets([place(2)], [place(2), place(5), place(9)], here)
  assert.equal(choice.kind, 'choose')
  if (choice.kind !== 'choose') return
  assert.deepEqual(choice.targets.map(target => target.line), [5, 9])
  assert.ok(choice.targets.every(target => target.kind === 'usage'))
})

test('a declaration with no usages does nothing', () => {
  const here = { path: 'a.ts', line: 2, character: 16 }
  assert.deepEqual(chooseTargets([place(2)], [place(2)], here), { kind: 'none' })
})

test('a usage click jumps to the declaration even when usages came back', () => {
  // tsserver answers references with the declaration included: without
  // "a definition wins" the click would open a list of usages.
  const choice = chooseTargets([place(2)], [place(2), place(5), place(9)], HERE)
  assert.equal(choice.kind, 'jump')
  if (choice.kind !== 'jump') return
  assert.equal(choice.target.line, 2)
  assert.equal(choice.target.kind, 'definition')
})

test('an overload still jumps to the first declaration from a usage', () => {
  const choice = chooseTargets([place(2), place(8)], [place(2), place(5)], HERE)
  assert.equal(choice.kind, 'jump')
  if (choice.kind !== 'jump') return
  assert.equal(choice.target.line, 2)
})

test('nothing found does nothing', () => {
  assert.deepEqual(chooseTargets([], [], HERE), { kind: 'none' })
})

test('the same place in both answers is named once, as a definition', () => {
  // Line 9 is a declaration *and* a usage in the answers; it must appear once,
  // labelled as the declaration (otherwise the list shows duplicates).
  const here = { path: 'a.ts', line: 2, character: 16 }
  const choice = chooseTargets([place(2), place(9)], [place(2), place(9)], here)
  assert.equal(choice.kind, 'jump')
  if (choice.kind !== 'jump') return
  assert.equal(choice.target.line, 9)
  assert.equal(choice.target.kind, 'definition')
})

test('a place reads as path:line, with no kind prefix', () => {
  // The list answers one question, so every row is the same kind by
  // construction — a column of identical words in front of the only thing
  // that differs is noise.
  const place = { path: 'src/math.ts', line: 13, character: 0, kind: 'usage' as const }
  assert.equal(describePlace(place), 'src/math.ts:13')
  assert.equal(describePlace({ ...place, kind: 'definition' }), 'src/math.ts:13')
})

test('a declaration click lists usages, each named once', () => {
  const here = { path: 'a.ts', line: 2, character: 16 }
  const choice = chooseTargets([place(2)], [place(2), place(9), place(9)], here)
  assert.equal(choice.kind, 'jump')
  if (choice.kind !== 'jump') return
  assert.equal(choice.target.line, 9)
})

test('wordTextAt reads the identifier from its start column', () => {
  const text = 'const total = compute(alpha)'
  assert.equal(wordTextAt(text, { line: 1, character: 14 }), 'compute')
  assert.equal(wordTextAt(text, { line: 1, character: 6 }), 'total')
  assert.equal(wordTextAt(text, { line: 1, character: 5 }), '', 'a space is not an identifier')
  assert.equal(wordTextAt(text, { line: 9, character: 0 }), '')
})
