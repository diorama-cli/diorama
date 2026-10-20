import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatKeys, shortcutRows } from '../src/bindings.ts'

test('formatKeys: apple uses glyphs, others spell the modifiers out', () => {
  assert.equal(formatKeys('mod+alt+w', true), '⌘⌥W')
  assert.equal(formatKeys('mod+alt+w', false), 'Ctrl+Alt+W')
  assert.equal(formatKeys('mod+k', true), '⌘K')
  assert.equal(formatKeys('mod+k', false), 'Ctrl+K')
  // `ctrl` is not `mod`: it keeps its own glyph/word on both platforms.
  assert.equal(formatKeys('ctrl+tab', true), '⌃Tab')
  assert.equal(formatKeys('ctrl+tab', false), 'Ctrl+Tab')
  assert.equal(formatKeys('ctrl+shift+tab', false), 'Ctrl+Shift+Tab')
})

test('formatKeys: named keys and single characters', () => {
  assert.equal(formatKeys('shift+?', true), '⇧?')
  assert.equal(formatKeys('shift+?', false), 'Shift+?')
  assert.equal(formatKeys('mod+alt+arrowright', true), '⌘⌥→')
  assert.equal(formatKeys('escape', true), 'Esc')
  assert.equal(formatKeys('', true), '')
})

test('shortcutRows: binding order, unknown commands dropped, unbound commands hidden', () => {
  const commands = [
    { id: 'tabs.close', title: '关闭当前标签页' },
    { id: 'tabs.next', title: '下一个标签页' },
    { id: 'view.toggleAutoRefresh', title: '自动刷新：开 / 关' },
  ]
  const bindings = [
    { keys: 'mod+alt+w', command: 'tabs.close' },
    { keys: 'mod+alt+arrowright', command: 'tabs.next' },
    // A binding left behind by a disposed command: not a row.
    { keys: 'mod+alt+z', command: 'gone.command' },
  ]
  const rows = shortcutRows(commands, bindings, () => true)
  assert.deepEqual(
    rows.map(row => row.id),
    ['tabs.close', 'tabs.next'],
  )
  // No binding → not a row: the sheet is about keys, not about commands.
  assert.equal(rows.some(row => row.id === 'view.toggleAutoRefresh'), false)
  assert.deepEqual(rows[0]?.keys, ['mod+alt+w'])
  assert.deepEqual(rows[1]?.keys, ['mod+alt+arrowright'])
  assert.equal(rows[0]?.title, '关闭当前标签页')
})

test('shortcutRows: unavailable commands stay, marked; duplicate keys collapse', () => {
  const commands = [{ id: 'tabs.close', title: '关闭当前标签页' }]
  const bindings = [
    { keys: 'mod+alt+w', command: 'tabs.close' },
    { keys: 'mod+alt+w', command: 'tabs.close' },
  ]
  const rows = shortcutRows(commands, bindings, id => id !== 'tabs.close')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.available, false)
  assert.deepEqual(rows[0]?.keys, ['mod+alt+w'])
})

test('shortcutRows: a command bound to several keys lists them in order', () => {
  const commands = [{ id: 'help.toggle', title: '快捷键说明' }]
  const bindings = [
    { keys: 'shift+?', command: 'help.toggle' },
    { keys: 'mod+/', command: 'help.toggle' },
  ]
  const rows = shortcutRows(commands, bindings, () => true)
  assert.deepEqual(rows[0]?.keys, ['shift+?', 'mod+/'])
})
