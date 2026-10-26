import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortcutRows } from '../src/bindings.ts'

/**
 * The shortcut sheet's rows (contract.md §3.7, §5).
 *
 * `formatKeys` used to be tested here too; it moved to the kernel when
 * controls started showing their own shortcuts (v0.15), and its tests moved
 * with it — `packages/kernel/test/keys.test.ts`. One table, one set of tests.
 */

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

test('shortcutRows: every tab slot shows up as its own row', () => {
  // ⌥1 … ⌥9 are nine commands, so the sheet lists nine rows — that is the
  // point of the sheet (contract.md §3.7, v0.15).
  const commands = Array.from({ length: 3 }, (_, index) => ({ id: `tabs.select:${index + 1}`, title: `第 ${index + 1} 个标签页` }))
  const bindings = commands.map((command, index) => ({ keys: `alt+${index + 1}`, command: command.id }))
  const rows = shortcutRows(commands, bindings, () => true)
  assert.deepEqual(rows.map(row => row.keys[0]), ['alt+1', 'alt+2', 'alt+3'])
})
