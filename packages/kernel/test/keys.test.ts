import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatKeys,
  hintOf,
  modifierOf,
  parseKeys,
  matchesKeys,
} from '../src/client/keys.ts'
import { heldModifier, heldModifierStore, holdModifier } from '../src/client/modifiers.ts'

/**
 * The key notation and the "which modifier is held" state (contract.md §3.7,
 * v0.15). The notation moved here out of the `help` piece when controls began
 * showing their own shortcuts: one table prints `⌘⌥W`, and the dispatcher, the
 * shortcut sheet and every chip read it.
 */

test('formatKeys: glyphs on a Mac, words elsewhere', () => {
  assert.equal(formatKeys('mod+alt+w', true), '⌘⌥W')
  assert.equal(formatKeys('mod+alt+w', false), 'Ctrl+Alt+W')
  assert.equal(formatKeys('mod+1', true), '⌘1')
  assert.equal(formatKeys('mod+1', false), 'Ctrl+1')
  // `ctrl` is not `mod`: it keeps its own glyph on both platforms.
  assert.equal(formatKeys('ctrl+tab', true), '⌃Tab')
  assert.equal(formatKeys('ctrl+tab', false), 'Ctrl+Tab')
  assert.equal(formatKeys('shift+?', true), '⇧?')
  assert.equal(formatKeys('mod+alt+arrowright', true), '⌘⌥→')
  assert.equal(formatKeys('escape', true), 'Esc')
  assert.equal(formatKeys('', true), '')
})

test('formatKeys: what parseKeys canonicalised prints the same everywhere', () => {
  // A binding is printed from its canonical text, so "alt+mod+w" and
  // "mod+alt+w" are one chip, not two spellings of it.
  const canonical = parseKeys('alt+mod+w', true)?.text ?? ''
  assert.equal(canonical, 'mod+alt+w')
  assert.equal(formatKeys(canonical, true), formatKeys('mod+alt+w', true))
})

test('hintOf: the first binding a command has, and nothing for a command without one', () => {
  const bindings = [
    { keys: 'mod+alt+w', command: 'tabs.close' },
    { keys: 'ctrl+w', command: 'tabs.close' },
    { keys: 'mod+k', command: 'palette.toggle' },
  ]
  assert.equal(hintOf(bindings, 'tabs.close'), 'mod+alt+w')
  assert.equal(hintOf(bindings, 'palette.toggle'), 'mod+k')
  assert.equal(hintOf(bindings, 'view.refresh'), undefined)
  assert.equal(hintOf([], 'tabs.close'), undefined)
})

test('modifierOf: ⌘ is mod on a Mac, Ctrl elsewhere, Option / Alt is alt on both', () => {
  const event = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) => ({
    key: 'a',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  })
  assert.equal(modifierOf(event({ metaKey: true }), true), 'mod')
  // ⌃ on a Mac is *not* the hint modifier: ⌘ is.
  assert.equal(modifierOf(event({ ctrlKey: true }), true), undefined)
  assert.equal(modifierOf(event({ ctrlKey: true }), false), 'mod')
  assert.equal(modifierOf(event({ metaKey: true }), false), undefined)
  assert.equal(modifierOf(event({ altKey: true }), true), 'alt')
  assert.equal(modifierOf(event({ altKey: true }), false), 'alt')
  assert.equal(modifierOf(event({}), true), undefined)
  // A plain key typed while a modifier is held keeps the hints up.
  assert.equal(modifierOf({ key: '1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true), 'mod')
})

test('modifierOf and matchesKeys agree about a composed Option key', () => {
  // ⌘⌥W arrives as '∑' on a Mac: the matcher uses the physical key, and the
  // hint state still sees ⌘ held (nothing here may depend on `key`).
  const composed = { key: '∑', code: 'KeyW', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }
  assert.equal(matchesKeys(composed, parseKeys('mod+alt+w', true)!), true)
  assert.equal(modifierOf(composed, true), 'mod')
})

test('keys: a shift binding matches the shifted character the browser reports', () => {
  // ⌘⇧[ arrives as key '{' with shiftKey true; the binding is written with the
  // keycap ('['), which is what an editor shows and what a reader types.
  const prev = parseKeys('mod+shift+[', true)!
  const event = { key: '{', code: 'BracketLeft', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true }
  assert.equal(matchesKeys(event, prev), true)
  assert.equal(matchesKeys({ ...event, key: ']' }, prev), false)
  // Without shift the same character is a different binding.
  assert.equal(matchesKeys({ ...event, shiftKey: false }, parseKeys('mod+[', true)!), false)
  // A letter key is unaffected: ⇧A is still `a` with shiftKey true.
  assert.equal(
    matchesKeys({ key: 'A', code: 'KeyA', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true }, parseKeys('mod+shift+a', true)!),
    true,
  )
})

test('the held modifier is a page-global string store, and repeating it is quiet', () => {
  holdModifier(undefined)
  const seen: string[] = []
  const off = heldModifierStore.subscribe(() => seen.push(heldModifierStore.getSnapshot()))
  try {
    assert.equal(heldModifierStore.getSnapshot(), '')
    holdModifier('mod')
    assert.equal(heldModifier(), 'mod')
    assert.equal(heldModifierStore.getSnapshot(), 'mod')
    // Holding ⌘ through a sequence of keystrokes notifies once, not once per key.
    holdModifier('mod')
    holdModifier('alt')
    holdModifier(undefined)
    assert.deepEqual(seen, ['mod', 'alt', ''])
  } finally {
    off()
  }
  // After the last unsubscribe nothing is notified any more.
  holdModifier('mod')
  assert.deepEqual(seen, ['mod', 'alt', ''])
  holdModifier(undefined)
})
