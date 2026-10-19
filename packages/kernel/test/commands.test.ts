import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandConflictError,
  createCommandsService,
  exclusive,
  matchesKeys,
  parseKeys,
  type CommandContext,
} from '../src/client/commands.ts'

const BASE: CommandContext = { mountId: 'm1', focus: 'other' }

function service(context: () => CommandContext = () => BASE) {
  const warnings: string[] = []
  const commands = createCommandsService({ context, warn: message => warnings.push(message), apple: true })
  return { commands, warnings }
}

test('keys: parse, order-independent modifiers, apple vs other platforms', () => {
  assert.deepEqual(parseKeys('mod+alt+w', true), { text: 'mod+alt+w', ctrl: false, meta: true, alt: true, shift: false, key: 'w' })
  assert.deepEqual(parseKeys('alt+mod+w', true), { text: 'mod+alt+w', ctrl: false, meta: true, alt: true, shift: false, key: 'w' })
  // The canonical text keeps `mod`: it names the same binding on every platform.
  assert.deepEqual(parseKeys('mod+alt+w', false), { text: 'mod+alt+w', ctrl: true, meta: false, alt: true, shift: false, key: 'w' })
  assert.deepEqual(parseKeys('ctrl+shift+tab', true), { text: 'ctrl+shift+tab', ctrl: true, meta: false, alt: false, shift: true, key: 'tab' })
  assert.deepEqual(parseKeys('mod+alt+arrowright', true)?.key, 'arrowright')
  assert.deepEqual(parseKeys('mod+k', true)?.key, 'k')
})

test('keys: malformed bindings are refused', () => {
  assert.equal(parseKeys('', true), undefined)
  assert.equal(parseKeys('mod+', true), undefined)
  assert.equal(parseKeys('mod+shift', true), undefined)
  assert.equal(parseKeys('hyper+k', true), undefined)
  // `mod` and `ctrl` name the same physical key on the same platform.
  assert.equal(parseKeys('mod+ctrl+k', true), undefined)
})

test('keys: matching requires exact modifiers and the same key', () => {
  const keys = parseKeys('mod+alt+w', true)!
  const event = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
    key: 'w',
    ctrlKey: false,
    metaKey: true,
    altKey: true,
    shiftKey: false,
    ...over,
  })
  assert.equal(matchesKeys(event({}), keys), true)
  assert.equal(matchesKeys(event({ key: 'W' }), keys), true)
  assert.equal(matchesKeys(event({ altKey: false }), keys), false)
  assert.equal(matchesKeys(event({ shiftKey: true }), keys), false)
  assert.equal(matchesKeys(event({ key: 'q' }), keys), false)
})

test('commands: duplicate ids throw; registration is reversible', () => {
  const { commands } = service()
  const dispose = commands.register({ id: 'tabs.close', title: 'Close', run: () => {} })
  assert.throws(() => commands.register({ id: 'tabs.close', title: 'Again', run: () => {} }), CommandConflictError)
  assert.equal(commands.getSnapshot().commands.length, 1)
  dispose()
  assert.equal(commands.getSnapshot().commands.length, 0)
  commands.register({ id: 'tabs.close', title: 'Close again', run: () => {} })
})

test('commands: literal key clashes throw, exclusive whens may share a key', () => {
  const { commands } = service()
  commands.register({ id: 'a:one', title: 'One', run: () => {} })
  commands.register({ id: 'a:two', title: 'Two', run: () => {} })
  commands.bind({ keys: 'mod+k', command: 'a:one' })
  assert.throws(() => commands.bind({ keys: 'mod+k', command: 'a:two' }), /already bound to "a:one"/)

  // Same physical key written differently is still a clash.
  assert.throws(() => commands.bind({ keys: 'meta+k', command: 'a:two' }), /not a key binding/)
  assert.throws(() => commands.bind({ keys: 'control+k', command: 'a:two' }), /not a key binding/)

  // Two predicates shown to be exclusive may share a key.
  const inTree = (context: CommandContext): boolean => context.focus === 'tree'
  const notTree = (context: CommandContext): boolean => context.focus !== 'tree'
  exclusive(inTree, notTree)
  commands.bind({ keys: 'mod+j', command: 'a:one', when: inTree })
  commands.bind({ keys: 'mod+j', command: 'a:two', when: notTree })
})

test('commands: canRun / run honour when, and unknown ids are loud no-ops', async () => {
  const { commands, warnings } = service(() => ({ ...BASE, activeTab: undefined }))
  let ran = 0
  commands.register({ id: 'view.refresh', title: 'Refresh', when: context => context.activeTab !== undefined, run: () => { ran++ } })
  assert.equal(commands.canRun('view.refresh'), false)
  assert.equal(await commands.run('view.refresh'), false)
  assert.equal(ran, 0)
  assert.equal(await commands.run('missing.command'), false)
  assert.equal(warnings.length, 2)
})

test('commands: handleKey runs the first available binding and ignores repeats', async () => {
  const current: { value: CommandContext } = { value: { ...BASE, activeTab: { id: 'tab-1', path: 'a.md' } } }
  const { commands, warnings } = service(() => current.value)
  const ran: string[] = []
  commands.register({ id: 'tabs.close', title: 'Close', run: () => ran.push('close') })
  commands.register({ id: 'tabs.next', title: 'Next', when: c => c.activeTab !== undefined, run: () => ran.push('next') })
  commands.bind({ keys: 'mod+alt+w', command: 'tabs.close' })
  commands.bind({ keys: 'mod+alt+arrowright', command: 'tabs.next' })

  const press = (key: string, extra: { altKey?: boolean } = {}) =>
    commands.handleKey({ key, ctrlKey: false, metaKey: true, altKey: extra.altKey ?? true, shiftKey: false })
  assert.equal(press('w'), true)
  assert.equal(press('w'), true)
  assert.equal(commands.handleKey({ key: 'w', ctrlKey: false, metaKey: true, altKey: true, shiftKey: false, repeat: true }), false)
  assert.equal(press('arrowright'), true)
  assert.equal(press('q'), false)
  // A binding whose `when` is false does not fire.
  current.value = { ...BASE }
  assert.equal(press('arrowright'), false)
  assert.deepEqual(ran, ['close', 'close', 'next'])
  assert.equal(warnings.length, 0)
})

test('commands: when throwing is contained (treated as unavailable)', async () => {
  const { commands, warnings } = service()
  commands.register({ id: 'bad:when', title: 'Bad', when: () => { throw new Error('boom') }, run: () => {} })
  assert.equal(commands.canRun('bad:when'), false)
  assert.equal(await commands.run('bad:when'), false)
  assert.ok(warnings.length >= 1)
})

test('commands: run failures are reported, not thrown', async () => {
  const { commands, warnings } = service()
  commands.register({ id: 'bad:run', title: 'Bad run', run: () => { throw new Error('nope') } })
  assert.equal(await commands.run('bad:run'), false)
  assert.match(warnings.at(-1) ?? '', /bad:run.*nope/)
})

test('commands: contributed sources refine the context field by field', async () => {
  const { commands } = service(() => BASE)
  const seen: CommandContext[] = []
  commands.register({ id: 'probe:ctx', title: 'Probe', run: context => { seen.push(context) } })
  const undo = commands.contribute({ activeTab: () => ({ id: 'tab-9', path: 'x/y.md' }), focus: () => 'tree' })
  await commands.run('probe:ctx')
  assert.deepEqual(seen.at(-1), { mountId: 'm1', activeTab: { id: 'tab-9', path: 'x/y.md' }, focus: 'tree' })
  undo()
  await commands.run('probe:ctx')
  assert.deepEqual(seen.at(-1), BASE)
})

test('commands: snapshot is stable between changes', () => {
  const { commands } = service()
  const first = commands.getSnapshot()
  assert.equal(commands.getSnapshot(), first)
  commands.register({ id: 'a:b', title: 'B', run: () => {} })
  const second = commands.getSnapshot()
  assert.notEqual(second, first)
  assert.deepEqual(second.commands.map(command => command.id), ['a:b'])
})
