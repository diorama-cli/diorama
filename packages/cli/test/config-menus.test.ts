import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { defaultConfig } from 'diorama-kernel/server'
import {
  booleanCandidates,
  externalIPv4,
  externalIPv6,
  hostCandidates,
  IGNORE_CANDIDATES,
  isExposed,
  pluginCandidates,
} from '../src/config-candidates.ts'
import {
  createMenuState,
  createTerminal,
  feedMenu,
  interpretInput,
  menuLines,
  parseKeys,
  type MenuConfig,
  type TerminalInput,
} from '../src/config-terminal.ts'
import { runWizard, summarizeChanges, type Change } from '../src/config-command.ts'

/**
 * Candidate menus (contract.md §4.2): the lists are shortcuts, never
 * restrictions — anything typed that is not a number is the value. Both the
 * candidate generation and the menu state machine are pure, and the terminal
 * takes its stream as a parameter, so nothing here needs a real TTY.
 */

// --- candidates -----------------------------------------------------------

/** The shape `os.networkInterfaces()` returns on a laptop with a VPN. */
const MACHINE = {
  lo0: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
    { address: 'fe80::1', family: 'IPv6', internal: true },
  ],
  en0: [
    { address: 'fe80::1866:15b3:f94f:80bc', family: 'IPv6', internal: false },
    { address: '10.64.33.84', family: 'IPv4', internal: false },
  ],
  awdl0: [{ address: 'fe80::e027:adff:feb0:68f1', family: 'IPv6', internal: false }],
  utun4: [{ address: '192.168.255.10', family: 'IPv4', internal: false }],
}

test('candidates: host offers loopback, every-interface, then each external IPv4', () => {
  const values = hostCandidates(MACHINE).map(candidate => candidate.value)
  assert.deepEqual(values, ['127.0.0.1', '0.0.0.0', '10.64.33.84', '192.168.255.10'])
  // The interface name is what makes a bare address readable.
  assert.equal(hostCandidates(MACHINE)[2]?.detail, 'en0')
  assert.equal(hostCandidates(MACHINE)[3]?.detail, 'utun4')
  // `::` is offered only when there is an external IPv6 address to use it for.
  assert.ok(!values.includes('::'))
  assert.deepEqual(
    hostCandidates({ en0: [{ address: '2001:db8::5', family: 'IPv6', internal: false }] }).map(c => c.value),
    ['127.0.0.1', '0.0.0.0', '::'],
  )
})

test('candidates: link-local IPv6 is never offered (it needs a zone id to be usable)', () => {
  assert.deepEqual(externalIPv6(MACHINE), [])
  assert.deepEqual(
    externalIPv6({ en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '2001:db8::1', family: 'IPv6', internal: false }] }),
    [{ address: '2001:db8::1', name: 'en0' }],
  )
})

test('candidates: internal and duplicate addresses are dropped', () => {
  assert.deepEqual(externalIPv4({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] }), [])
  const duplicated = {
    en0: [{ address: '10.0.0.2', family: 'IPv4', internal: false }],
    en1: [{ address: '10.0.0.2', family: 'IPv4', internal: false }],
  }
  assert.deepEqual(externalIPv4(duplicated), [{ address: '10.0.0.2', name: 'en0' }])
})

test('candidates: a host from the file that is not on this machine stays visible', () => {
  const values = hostCandidates(MACHINE, '192.168.1.50').map(candidate => candidate.value)
  assert.equal(values.at(-1), '192.168.1.50')
  assert.match(hostCandidates(MACHINE, '192.168.1.50').at(-1)?.detail ?? '', /not an address on this machine/)
  // A value that is already on the list is not repeated.
  assert.equal(hostCandidates(MACHINE, '10.64.33.84').filter(value => value.value === '10.64.33.84').length, 1)
})

test('candidates: only loopback counts as unexposed', () => {
  assert.equal(isExposed('127.0.0.1'), false)
  assert.equal(isExposed('localhost'), false)
  assert.equal(isExposed('::1'), false)
  assert.equal(isExposed('0.0.0.0'), true)
  assert.equal(isExposed('::'), true)
  assert.equal(isExposed('10.64.33.84'), true)
})

test('candidates: the ignore list starts with the contract defaults', () => {
  assert.deepEqual(IGNORE_CANDIDATES.slice(0, 2).map(candidate => candidate.value), ['.git', 'node_modules'])
  assert.equal(new Set(IGNORE_CANDIDATES.map(candidate => candidate.value)).size, IGNORE_CANDIDATES.length)
})

test('candidates: plugins and booleans mark what is currently on', () => {
  assert.deepEqual(pluginCandidates(['slots', 'tabs'], ['tabs']).map(c => c.recommended), [false, true])
  assert.deepEqual(booleanCandidates(false).map(c => c.value), ['true', 'false'])
  assert.equal(booleanCandidates(false)[1]?.recommended, true)
})

// --- keys and menu state --------------------------------------------------

test('keys: arrows, enter, backspace and letters decode separately', () => {
  assert.deepEqual(parseKeys('\x1b[A'), [{ name: 'up' }])
  assert.deepEqual(parseKeys('\x1b[B'), [{ name: 'down' }])
  assert.deepEqual(parseKeys('a\r'), [{ name: 'char', value: 'a' }, { name: 'enter' }])
  assert.deepEqual(parseKeys('\x7f'), [{ name: 'backspace' }])
  assert.deepEqual(parseKeys('\x15'), [{ name: 'kill' }])
  assert.deepEqual(parseKeys('\x03'), [{ name: 'interrupt' }])
  assert.deepEqual(parseKeys('\x04'), [{ name: 'eof' }])
  // An arrow sequence must never leak its `[` and `A` into the typed text.
  assert.deepEqual(parseKeys('\x1b[Bx'), [{ name: 'down' }, { name: 'char', value: 'x' }])
})

function menu(overrides: Partial<MenuConfig> = {}): MenuConfig {
  return {
    title: 'host',
    candidates: [{ value: '127.0.0.1' }, { value: '0.0.0.0' }, { value: '10.0.0.2' }],
    multi: false,
    selected: ['127.0.0.1'],
    footer: 'Enter keeps',
    ...overrides,
  }
}

test('menu: a number picks a candidate, anything else is a free value', () => {
  assert.deepEqual(interpretInput(menu(), '2'), { kind: 'chosen', values: ['0.0.0.0'] })
  assert.deepEqual(interpretInput(menu(), '192.168.1.5'), { kind: 'free', text: '192.168.1.5' })
  assert.deepEqual(interpretInput(menu(), ''), { kind: 'keep' })
  // A number that is not on the list is a typo, not an address.
  assert.equal(interpretInput(menu(), '9').kind, 'invalid')
  assert.equal(interpretInput(menu(), '0').kind, 'invalid')
})

test('menu: a multi-select toggles by number and keeps candidate order', () => {
  // Drawn with only row 1 checked: `3` adds, `1` removes, and the result keeps
  // the on-screen order (which is the boot order for plugins).
  const multi = menu({ multi: true })
  assert.deepEqual(interpretInput(multi, '3'), { kind: 'chosen', values: ['127.0.0.1', '10.0.0.2'] })
  assert.deepEqual(interpretInput(multi, '1'), { kind: 'chosen', values: [] })
  assert.deepEqual(interpretInput(multi, '1,3'), { kind: 'chosen', values: ['10.0.0.2'] })
  // Toggling twice is not a thing in one line: each number is applied once.
  assert.deepEqual(interpretInput(multi, 'dist,*.log'), { kind: 'free', text: 'dist,*.log' })
})

test('menu: arrows move the cursor and wrap; space toggles in a multi-select', () => {
  let state = createMenuState(menu({ multi: true }))
  const down = feedMenu(menu({ multi: true }), state, { name: 'down' })
  assert.equal(down.state.cursor, 1)
  state = down.state
  const toggled = feedMenu(menu({ multi: true }), state, { name: 'space' })
  assert.deepEqual(toggled.state.checked, [true, true, false])
  // Wrap-around, both ways.
  let up = createMenuState(menu({ multi: true }))
  up = feedMenu(menu({ multi: true }), up, { name: 'up' }).state
  assert.equal(up.cursor, 2)
})

test('menu: Enter takes the cursor row in a single-choice menu, the checked rows otherwise', () => {
  const single = feedMenu(menu(), createMenuState(menu()), { name: 'enter' })
  assert.deepEqual(single.outcome, { kind: 'chosen', values: ['127.0.0.1'] })

  const multi = menu({ multi: true })
  const state = createMenuState(multi)
  const checked = feedMenu(multi, state, { name: 'enter' })
  assert.deepEqual(checked.outcome, { kind: 'chosen', values: ['127.0.0.1'] })
})

test('menu: typing digits then Enter picks the number; a bad number shows a note and stays', () => {
  const config = menu()
  let state = createMenuState(config)
  state = feedMenu(config, state, { name: 'char', value: '2' }).state
  const done = feedMenu(config, state, { name: 'enter' })
  assert.deepEqual(done.outcome, { kind: 'chosen', values: ['0.0.0.0'] })

  let bad = createMenuState(config)
  bad = feedMenu(config, bad, { name: 'char', value: '9' }).state
  const rejected = feedMenu(config, bad, { name: 'enter' })
  assert.equal(rejected.outcome, undefined)
  assert.match(rejected.state.note ?? '', /is not on this list/)
  assert.equal(rejected.state.typed, '')
})

test('menu: backspace edits, Escape keeps the current value', () => {
  const config = menu()
  let state = createMenuState(config)
  state = feedMenu(config, state, { name: 'char', value: '1' }).state
  state = feedMenu(config, state, { name: 'backspace' }).state
  assert.equal(state.typed, '')
  assert.deepEqual(feedMenu(config, state, { name: 'escape' }).outcome, { kind: 'keep' })
})

test('menu: the drawn lines carry numbers, checkboxes and the footer', () => {
  const config = menu({
    multi: true,
    candidates: [{ value: 'slots', detail: 'piece' }, { value: 'tabs' }],
    selected: ['slots'],
  })
  const lines = menuLines(config, createMenuState(config))
  assert.match(lines[0] as string, /^host$/)
  assert.match(lines[1] as string, /\[x\] slots/)
  assert.match(lines[2] as string, /\[ \] tabs/)
  assert.equal(lines.at(-1), '  Enter keeps')
})

// --- the terminal ---------------------------------------------------------

/**
 * A stream that looks like a TTY. `Readable` is not used: `isTTY` is a
 * prototype getter there, so an assignment is silently ignored and the terminal
 * would take the pipe path. An `EventEmitter` with `isTTY` + `setRawMode` is
 * exactly the shape `createTerminal` asks for.
 */
interface FakeTty extends TerminalInput {
  rawModes: boolean[]
  listenerCount(event: string): number
  /** Feed bytes, the way a terminal delivers them. */
  send(text: string): void
  end(): void
}

function fakeTty(): FakeTty {
  const emitter = new EventEmitter() as unknown as FakeTty
  emitter.isTTY = true
  emitter.rawModes = []
  emitter.setRawMode = (mode: boolean) => {
    emitter.rawModes.push(mode)
  }
  emitter.send = (text: string) => {
    emitter.emit('data', Buffer.from(text, 'utf8'))
  }
  emitter.end = () => {
    emitter.emit('end')
  }
  return emitter
}

/** A pipe: lines arrive as `data`, and the end is an event. */
interface FakePipe extends TerminalInput {
  send(text: string): void
  end(): void
}

function pipe(): FakePipe {
  const emitter = new EventEmitter() as unknown as FakePipe
  emitter.send = (text: string) => {
    emitter.emit('data', Buffer.from(text, 'utf8'))
  }
  emitter.end = () => {
    emitter.emit('end')
  }
  return emitter
}

const tick = (): Promise<void> => new Promise(done => setImmediate(done))

test('terminal: a pipe reads whole lines, including a last line without a newline', async () => {
  const input = pipe()
  const terminal = createTerminal(input, () => {})
  assert.equal(terminal.rich, false)
  const first = terminal.line('a: ')
  input.send('8080\r\n')
  assert.equal(await first, '8080')
  const second = terminal.line('b: ')
  input.send('tail')
  input.end()
  assert.equal(await second, 'tail')
  // And then the stream is over: an answer, not a hang.
  assert.equal(await terminal.line('c: '), undefined)
  terminal.close()
})

test('terminal: a menu in a pipe prints once and reads one line', async () => {
  const input = pipe()
  const written: string[] = []
  const terminal = createTerminal(input, text => written.push(text))
  const answer = terminal.select(menu())
  await tick()
  input.send('3\n')
  assert.deepEqual(await answer, { kind: 'chosen', values: ['10.0.0.2'] })
  assert.ok(written.join('').includes('127.0.0.1'))
  terminal.close()
})

test('terminal: a bad answer in a pipe re-asks instead of keeping the value', async () => {
  const input = pipe()
  const written: string[] = []
  const terminal = createTerminal(input, text => written.push(text))
  const answer = terminal.select(menu())
  await tick()
  input.send('42\n')
  await tick()
  input.send('2\n')
  assert.deepEqual(await answer, { kind: 'chosen', values: ['0.0.0.0'] })
  assert.ok(written.join('').includes('is not on this list'))
  terminal.close()
})

test('terminal: rich mode turns raw mode on, draws in place, and reads arrow keys', async () => {
  const input = fakeTty()
  const written: string[] = []
  const terminal = createTerminal(input, text => written.push(text))
  assert.equal(terminal.rich, true)

  const answer = terminal.select(menu())
  await tick()
  assert.deepEqual(input.rawModes, [true])
  input.send('\x1b[B')
  await tick()
  input.send('\r')
  assert.deepEqual(await answer, { kind: 'chosen', values: ['0.0.0.0'] })
  // Redrawn in place (cursor-up by the number of lines drawn), and raw mode
  // restored afterwards.
  assert.match(written.join(''), /\x1b\[\d+A\x1b\[J/)
  assert.deepEqual(input.rawModes, [true, false])
  terminal.close()
})

test('terminal: rich mode echoes typed characters for a free-text question', async () => {
  const input = fakeTty()
  const written: string[] = []
  const terminal = createTerminal(input, text => written.push(text))
  const answer = terminal.line('port: ')
  await tick()
  input.send('8')
  await tick()
  // `0`, backspace, `9`: the echo has to undo the erased character too.
  input.send('0\x7f9\r')
  assert.equal(await answer, '89')
  // Every keystroke is echoed; a backspace erases the character it undid.
  assert.equal(written.join(''), 'port: 80\b \b9\n')
  assert.deepEqual(input.rawModes, [true, false])
  terminal.close()
})

test('terminal: an escape sequence split across chunks still reads as one arrow key', async () => {
  const input = fakeTty()
  const terminal = createTerminal(input, () => {})
  const answer = terminal.select(menu())
  await tick()
  input.send('\x1b')
  await tick()
  input.send('[B')
  await tick()
  input.send('\r')
  assert.deepEqual(await answer, { kind: 'chosen', values: ['0.0.0.0'] })
  terminal.close()
})

test('terminal: closing a TTY pauses it, so the process can exit after the file is written', async () => {
  const input = fakeTty()
  // A flowing stdin keeps the event loop alive: the wizard would write the
  // file and then hang until Ctrl-C. `close()` has to hand the loop back.
  const paused: string[] = []
  input.pause = () => {
    paused.push('pause')
  }
  const terminal = createTerminal(input, () => {})
  terminal.close()
  assert.deepEqual(paused, ['pause'])
  assert.deepEqual(input.rawModes, [false])
  assert.equal(input.listenerCount('data'), 0)
})

test('terminal: a TTY that ends mid-menu is reported as ended, not as a choice', async () => {
  const input = fakeTty()
  const terminal = createTerminal(input, () => {})
  const answer = terminal.select(menu())
  await tick()
  input.end()
  assert.equal(await answer, undefined)
  terminal.close()
})

// --- the wizard over menus ------------------------------------------------

test('wizard: a menu picks a candidate, and the change is summarized', async () => {
  const lines: string[] = []
  const answers = ['2', '', '1,2', '3', '2', '', '']
  let index = 0
  const result = await runWizard(
    {},
    {
      line: async () => answers[index++],
      select: async (config) => {
        const outcome = interpretInput(config, answers[index++])
        return outcome.kind === 'invalid' ? { kind: 'keep' } : outcome
      },
    },
    { defaults: defaultConfig(), out: message => lines.push(message), interfaces: MACHINE },
  )
  assert.equal(result.config.host, '0.0.0.0')
  // `1,2` toggles the first two pieces *off* (they were all on), so the rest
  // survive in boot order — the number acts like the checkbox, not like a list.
  assert.deepEqual(result.config.plugins?.slice(0, 2), ['file-tree', 'tabs'])
  assert.ok(!result.config.plugins?.includes('slots'))
  assert.ok(!result.config.plugins?.includes('layout'))
  assert.deepEqual(result.config.ignore, ['.git', 'node_modules', 'dist'])
  assert.equal(result.config.watch?.enabled, false)
  // Choosing a network-wide address warns; loopback does not.
  assert.ok(lines.some(line => line.includes('reachable from other machines')))
  // Summarized against what the reader sees today: defaults ← file.
  const summary = summarizeChanges(result.changes, defaultConfig())
  assert.ok(summary.includes('host: 127.0.0.1 → 0.0.0.0'))
  assert.ok(summary.includes('ignore: +dist'))
})

test('wizard: a free value still wins over the list, and "-" clears', async () => {
  const result = await runWizard(
    { host: '10.64.33.84', ignore: ['.git'] },
    {
      line: async () => '',
      select: async (config) => {
        if (config.title.startsWith('host')) return { kind: 'free', text: '10.0.0.9' }
        if (config.title.startsWith('ignore')) return { kind: 'free', text: '-' }
        return { kind: 'keep' }
      },
    },
    { defaults: defaultConfig(), out: () => {}, interfaces: MACHINE },
  )
  assert.equal(result.config.host, '10.0.0.9')
  assert.equal(result.config.ignore, undefined)
  const changes: Change[] = result.changes
  assert.deepEqual(changes.find(change => change.key === 'ignore'), { key: 'ignore', value: undefined, cleared: true })
})

test('wizard: "all" and "none" take and empty a multi-select', async () => {
  const run = async (word: string): Promise<string[] | undefined> =>
    (
      await runWizard(
        {},
        {
          line: async () => '',
          select: async (config) =>
            config.title.startsWith('ignore') ? { kind: 'free', text: word } : { kind: 'keep' },
        },
        { defaults: defaultConfig(), out: () => {}, interfaces: MACHINE },
      )
    ).config.ignore
  assert.deepEqual(await run('none'), [])
  assert.deepEqual(await run('all'), IGNORE_CANDIDATES.map(candidate => candidate.value))
})

test('wizard: the ignore menu lists custom patterns from the file so they can be toggled off', async () => {
  let seen: string[] = []
  await runWizard(
    { ignore: ['.git', 'my-generated'] },
    {
      line: async () => '',
      select: async (config) => {
        if (config.title.startsWith('ignore')) seen = config.candidates.map(candidate => candidate.value)
        return { kind: 'keep' }
      },
    },
    { defaults: defaultConfig(), out: () => {}, interfaces: MACHINE },
  )
  assert.equal(seen[0], 'my-generated')
  assert.ok(seen.includes('.git'))
})

test('wizard: input that ends in a menu is an error, never a partial write', async () => {
  await assert.rejects(
    runWizard({}, { line: async () => '', select: async () => undefined }, { defaults: defaultConfig(), out: () => {} }),
    /input ended before the wizard finished/,
  )
})
