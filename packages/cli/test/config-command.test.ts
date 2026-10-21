import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig, parseConfigFile } from 'diorama-kernel/server'
import {
  configCommand,
  displayValue,
  parseConfigValue,
  parseList,
  runWizard,
  UsageError,
} from '../src/config-command.ts'
import type { CliIo } from '../src/control-client.ts'
import {
  createTerminal,
  interpretInput,
  type MenuConfig,
  type MenuOutcome,
  type TerminalInput,
} from '../src/config-terminal.ts'

/**
 * `diorama config` (contract.md §4.2): the value grammar, the wizard's
 * questions, and the file the command leaves behind. The wizard is driven by a
 * scripted terminal (and, for the whole command, a scripted stdin), so no test
 * needs a real TTY; the menus themselves are covered by `config-menus.test.ts`.
 */

/** An IO pair that records what the user would see. */
function recorder(env: NodeJS.ProcessEnv = {}): { io: CliIo; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    io: {
      // Mirrors `defaultIo`: `out` is one line, `raw` is exact bytes.
      out: (message: string) => lines.push(`${message}\n`),
      raw: (text: string) => lines.push(text),
      err: (message: string) => lines.push(`!${message}`),
      env,
    },
  }
}

/**
 * A scripted terminal: one answer per question, in order. Free-text questions
 * take the next answer; menus take the next answer as typed input. Running out
 * is a test bug, not a hang.
 */
function scripted(answers: readonly string[], questions: string[] = []): {
  line(question: string): Promise<string | undefined>
  select(config: MenuConfig): Promise<MenuOutcome>
  questions: string[]
} {
  let index = 0
  return {
    questions,
    async line(question) {
      questions.push(question)
      return answers[index++]
    },
    async select(config) {
      questions.push(config.title)
      // The same grammar the terminal uses: a number picks, text is free.
      return interpretInput(config, answers[index++] ?? '')
    },
  }
}

test('config value grammar: lists split on commas, empty means empty', () => {
  assert.deepEqual(parseList('slots, layout ,tabs'), ['slots', 'layout', 'tabs'])
  assert.deepEqual(parseList(''), [])
  assert.deepEqual(parseList(' , '), [])
  assert.deepEqual(parseConfigValue('ignore', '.git, *.log'), ['.git', '*.log'])
})

test('config value grammar: numbers are integers inside their documented range', () => {
  assert.equal(parseConfigValue('port', '8080'), 8080)
  assert.equal(parseConfigValue('port', '0'), 0)
  assert.equal(parseConfigValue('watch.debounceMs', '0'), 0)
  assert.equal(parseConfigValue('watch.maxDirectories', '4096'), 4096)
  for (const [key, raw] of [
    ['port', '70000'],
    ['port', '1.5'],
    ['port', 'eighty'],
    ['watch.debounceMs', '-1'],
    ['watch.maxDirectories', '0'],
  ] as const) {
    assert.throws(() => parseConfigValue(key, raw), UsageError, `${key}=${raw} must be rejected`)
  }
})

test('config value grammar: booleans accept the usual spellings, nothing else', () => {
  for (const raw of ['true', 'yes', 'on', '1']) assert.equal(parseConfigValue('watch.enabled', raw), true)
  for (const raw of ['false', 'no', 'off', '0']) assert.equal(parseConfigValue('watch.enabled', raw), false)
  assert.throws(() => parseConfigValue('watch.enabled', 'maybe'), /must be true or false/)
})

test('config value grammar: unknown keys are rejected with the known list', () => {
  assert.throws(() => parseConfigValue('colour', 'red'), /unknown key "colour".*watch\.maxDirectories/)
  assert.throws(() => parseConfigValue('host', '  '), /must not be empty/)
})

test('display: arrays read as a comma list, absent values say so', () => {
  assert.equal(displayValue(['.git', 'node_modules']), '.git, node_modules')
  assert.equal(displayValue([]), '')
  assert.equal(displayValue(8080), '8080')
  assert.equal(displayValue(undefined), '(unset)')
})

test('wizard: Enter keeps a field, a typed value replaces it, "-" clears it', async () => {
  const seen: string[] = []
  const result = await runWizard(
    { port: 4000, ignore: ['dist'] },
    scripted(['', '8080', '', '-', '2', '', '']),
    { defaults: defaultConfig(), out: message => seen.push(message) },
  )
  assert.deepEqual(result.config, {
    port: 8080,
    // `ignore` was cleared by "-", `host` was never set: both are gone.
    watch: { enabled: false },
  })

  assert.equal(result.changed, true)
  // Clearing shows up in the change list the command prints before writing.
  assert.deepEqual(
    result.changes.map(change => change.key),
    ['port', 'ignore', 'watch.enabled'],
  )
  assert.equal(result.changes[1]?.cleared, true)
  assert.deepEqual(seen, [])
})

test('wizard: a value the file would reject re-asks instead of aborting', async () => {
  const seen: string[] = []
  // host(menu) '', port 'eighty' then '9090', plugins(menu) '', ignore(menu) '',
  // watch.enabled(menu) '', debounce '', maxDirectories ''.
  const answers = ['', 'eighty', '9090', '', '', '', '', '']
  let index = 0
  const questions: string[] = []
  const result = await runWizard(
    {},
    {
      line: async (question) => {
        questions.push(question)
        return answers[index++]
      },
      // Each menu consumes one answer, exactly like the real terminal.
      select: async () => {
        index++
        return { kind: 'keep' }
      },
    },
    { defaults: defaultConfig(), out: message => seen.push(message) },
  )

  assert.equal(result.config.port, 9090)
  assert.ok(seen.some(line => line.includes('--port must be an integer 0–65535')))
  // The port question was asked twice: the bad answer did not move on.
  assert.equal(questions.filter(question => question.startsWith('  port')).length, 2)
})

test('wizard: nothing typed writes nothing', async () => {
  const result = await runWizard({ port: 4000 }, scripted(['', '', '', '', '', '', '']), {
    defaults: defaultConfig(),
    out: () => {},
  })
  assert.equal(result.changed, false)
  assert.deepEqual(result.config, { port: 4000 })
})

test('wizard: input that ends mid-way is an error, never a half-written file', async () => {
  await assert.rejects(
    runWizard({}, scripted(['', '']), { defaults: defaultConfig(), out: () => {} }),
    /input ended before the wizard finished/,
  )
})

test('wizard: numeric fields ask for a number; only listed fields open a menu', async () => {
  const asked: string[] = []
  const result = await runWizard(
    { port: 4000 },
    {
      line: async (question) => {
        asked.push(question)
        return ''
      },
      select: async (config) => {
        asked.push(config.title)
        return { kind: 'keep' }
      },
    },
    { defaults: defaultConfig(), out: () => {} },
  )
  // The four fields with sensible candidates are menus; the three numeric ones
  // stay plain questions — a typed number is a number, never "item N".
  assert.deepEqual(asked, [
    'host — where the page listens',
    '  port [4000] (file, 0 = a free port): ',
    'plugins — client pieces, in boot order',
    'ignore — hidden patterns (gitignore syntax)',
    'watch.enabled — false = no file watching at all',
    '  watch.debounceMs [300] (default, 0–60000): ',
    '  watch.maxDirectories [64] (default, 1–4096): ',
  ])
  assert.equal(result.changed, false)
})

test('terminal: lines arrive one at a time, CRLF is trimmed, the end is a value', async () => {
  const { EventEmitter } = await import('node:events')
  const input = new EventEmitter() as unknown as TerminalInput & {
    send(text: string): void
    end(): void
  }
  input.send = text => (input as unknown as EventEmitter).emit('data', Buffer.from(text, 'utf8'))
  input.end = () => (input as unknown as EventEmitter).emit('end')
  const asked: string[] = []
  const terminal = createTerminal(input, text => asked.push(text))
  const first = terminal.line('first: ')
  input.send('8080\r\n')
  assert.equal(await first, '8080')
  const second = terminal.line('second: ')
  input.send('tail')
  input.end()
  assert.equal(await second, 'tail')
  // Then the stream is over: `undefined`, not a promise that never settles.
  assert.equal(await terminal.line('third: '), undefined)
  terminal.close()
  assert.deepEqual(asked, ['first: ', 'second: ', 'third: '])
})

/** Wait until the recorded output satisfies `predicate` (the wizard is async). */
async function until(lines: readonly string[], predicate: (text: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const text = lines.join('')
    if (predicate(text)) return text
    await new Promise(done => setImmediate(done))
  }
  throw new Error(`condition never met; output was:\n${lines.join('')}`)
}

test('wizard: drawing goes through the raw sink, so a redraw replaces a frame', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diorama-config-'))
  const project = mkdtempSync(join(tmpdir(), 'diorama-project-'))
  try {
    const { io, lines } = recorder({ DIORAMA_HOME: home })
    const input = new EventEmitter() as unknown as TerminalInput & { send(text: string): void; end(): void }
    input.isTTY = true
    input.setRawMode = () => {}
    input.send = text => (input as unknown as EventEmitter).emit('data', Buffer.from(text, 'utf8'))
    input.end = () => (input as unknown as EventEmitter).emit('end')

    const running = configCommand(io, ['--dir', project], { stdin: input })
    await until(lines, text => text.includes('host — where the page listens'))
    // Move down once: the frame is redrawn, not appended.
    input.send('\x1b[B')
    await until(lines, text => text.split('host — where the page listens').length > 2)
    // Then keep every field, and decline the write once the preview asks.
    for (const key of ['\r', '\r', '\r', '\r', '\r', '\r', '\r', 'n\r']) {
      input.send(key)
      await new Promise(done => setImmediate(done))
    }
    assert.equal(await running, 0)

    const written = lines.join('')
    // One cursor-up per redraw, and the title is written once per frame — the
    // bug was `io.out` adding a newline after every escape, which made each
    // frame land below the last one.
    const frames = written.split('host — where the page listens').length - 1
    assert.equal(frames, 2, `expected 2 frames (initial + one redraw), got ${frames}`)
    assert.match(written, /\x1b\[\d+A\x1b\[J/, 'a redraw must move up before erasing')
    // No stray newline between the cursor-up and the erase.
    assert.ok(!/\x1b\[\d+A\n/.test(written), 'escape sequences must not be split by a newline')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('config set: writes the named file, leaving the rest of it alone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diorama-config-'))
  try {
    const { io, lines } = recorder({ DIORAMA_HOME: home })
    const code = await configCommand(io, ['set', '--port', '8080', '--ignore', '', '--watch.enabled', 'false'])
    assert.equal(code, 0)
    const text = readFileSync(join(home, 'diorama.toml'), 'utf8')
    assert.equal(text, 'port = 8080\nignore = []\n\n[watch]\nenabled = false\n')
    assert.deepEqual(parseConfigFile(text, 'written'), {
      port: 8080,
      ignore: [],
      watch: { enabled: false },
    })
    assert.ok(lines.some(line => line.startsWith('wrote ')))

    // A second `set` edits the same file rather than replacing it.
    const again = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(again.io, ['set', '--host', '0.0.0.0']), 0)
    assert.equal(
      readFileSync(join(home, 'diorama.toml'), 'utf8'),
      'host = "0.0.0.0"\nport = 8080\nignore = []\n\n[watch]\nenabled = false\n',
    )

    // `--all` is the documented spelling of `ignore = []`.
    const all = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(all.io, ['unset', 'ignore']), 0)
    assert.equal(await configCommand(all.io, ['set', '--all']), 0)
    assert.equal(readFileSync(join(home, 'diorama.toml'), 'utf8'), 'host = "0.0.0.0"\nport = 8080\nignore = []\n\n[watch]\nenabled = false\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('config set: --dir names the project file, and --config names any file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diorama-config-'))
  const project = mkdtempSync(join(tmpdir(), 'diorama-project-'))
  try {
    const { io } = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(io, ['set', '--dir', project, '--port', '1234']), 0)
    assert.equal(readFileSync(join(project, 'diorama.toml'), 'utf8'), 'port = 1234\n')

    const elsewhere = join(home, 'nested', 'dio.toml')
    assert.equal(await configCommand(io, ['set', '--config', elsewhere, '--host', '10.0.0.1']), 0)
    assert.equal(readFileSync(elsewhere, 'utf8'), 'host = "10.0.0.1"\n')
    // The default location was not touched by either.
    assert.throws(() => readFileSync(join(home, 'diorama.toml'), 'utf8'), /ENOENT/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('config set: --dry-run prints the file and writes nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diorama-config-'))
  try {
    const { io, lines } = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(io, ['set', '--port', '8080', '--dry-run']), 0)
    assert.ok(lines.some(line => line === 'port = 8080\n'))
    assert.ok(lines.some(line => line.startsWith('dry run: not writing ')))
    assert.throws(() => readFileSync(join(home, 'diorama.toml'), 'utf8'), /ENOENT/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('config unset: removing the last key leaves an empty file, not a defaults dump', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diorama-config-'))
  try {
    const { io } = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(io, ['set', '--port', '8080']), 0)
    assert.equal(await configCommand(io, ['unset', 'port']), 0)
    assert.equal(readFileSync(join(home, 'diorama.toml'), 'utf8'), '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('config set: usage errors exit 2 and write nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diorama-config-'))
  try {
    for (const argv of [
      ['set'],
      ['set', '--port', 'nope'],
      ['set', '--colour', 'red'],
      ['set', '--port'],
      ['set', 'positional'],
      ['unset'],
      ['show', '/definitely/not/a/directory'],
      ['nonsense'],
      // A flag that would silently do nothing is a usage error, not a no-op.
      ['show', '--dry-run'],
      ['unset', 'port', '--all'],
      ['set', '--json', '--port', '1'],
    ]) {
      const { io, lines } = recorder({ DIORAMA_HOME: home })
      assert.equal(await configCommand(io, argv), 2, argv.join(' '))
      assert.ok(lines.some(line => line.startsWith('!')), argv.join(' '))
    }
    assert.throws(() => readFileSync(join(home, 'diorama.toml'), 'utf8'), /ENOENT/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('config show: the effective configuration, with its source', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diorama-config-'))
  const project = mkdtempSync(join(tmpdir(), 'diorama-project-'))
  try {
    const { io, lines } = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(io, ['show', project]), 0)
    assert.ok(lines[0]?.includes('none (defaults)'))
    assert.ok(lines.some(line => line.includes('watch.maxDirectories = 64')))

    const written = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(written.io, ['set', '--dir', project, '--port', '4321']), 0)

    const shown = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(shown.io, ['show', project, '--json']), 0)
    const parsed = JSON.parse(shown.lines.join('\n')) as { config: { port: number }; configFile: string }
    assert.equal(parsed.config.port, 4321)
    // `show` resolves the directory the way serving does (realpath first).
    const real = realpathSync(project)
    assert.equal(parsed.configFile, join(real, 'diorama.toml'))

    const text = recorder({ DIORAMA_HOME: home })
    assert.equal(await configCommand(text.io, ['show', project]), 0)
    assert.equal(text.lines[0], `config file: ${join(real, 'diorama.toml')}\n`)
    assert.ok(text.lines.includes('  port = 4321\n'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
