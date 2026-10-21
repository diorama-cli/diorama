/**
 * The terminal the wizard talks to (contract.md §4.2).
 *
 * Two modes, one API:
 *
 * - **Rich** (stdin is a TTY): menus are drawn in place and driven by arrow
 *   keys / space / numbers, and free-text questions echo per keystroke. This is
 *   the mode a person gets.
 * - **Line** (a pipe, a test, a CI job): every question is a numbered list
 *   followed by one line of input. Same grammar, no escape sequences.
 *
 * Keeping both behind one interface means the wizard's decisions (what is
 * asked, what Enter / "-" / a number mean) exist once, in `config-command.ts`,
 * and only the drawing differs.
 *
 * Nothing here touches `process.stdin` directly: the stream is a parameter, so
 * the whole thing runs against a `Readable` in tests — including the key
 * sequences, which are the part most likely to break.
 */

/** One key press, decoded from a chunk of bytes. */
export type Key =
  | { name: 'enter' }
  | { name: 'space' }
  | { name: 'up' }
  | { name: 'down' }
  | { name: 'backspace' }
  | { name: 'kill' }
  | { name: 'tab' }
  | { name: 'escape' }
  | { name: 'interrupt' }
  | { name: 'eof' }
  | { name: 'char'; value: string }

/**
 * Decode a chunk into keys. Escape sequences are matched greedily so that
 * `\x1b[A` (up) never turns into a stray `[` and `A` typed into a menu.
 */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = []
  for (let index = 0; index < chunk.length; index++) {
    const char = chunk[index] as string
    if (char === '\x1b') {
      const next = chunk[index + 1]
      if (next === '[' || next === 'O') {
        let end = index + 2
        while (end < chunk.length && !/[A-Za-z~]/.test(chunk[end] as string)) end++
        const sequence = chunk.slice(index, end + 1)
        if (sequence.endsWith('A')) keys.push({ name: 'up' })
        else if (sequence.endsWith('B')) keys.push({ name: 'down' })
        // Left/right/home/end/delete are not used: ignoring them is safer than
        // guessing at their meaning in a two-dimensional menu.
        index = end
        continue
      }
      keys.push({ name: 'escape' })
      continue
    }
    if (char === '\r' || char === '\n') keys.push({ name: 'enter' })
    else if (char === '\x7f' || char === '\b') keys.push({ name: 'backspace' })
    else if (char === '\x15') keys.push({ name: 'kill' })
    else if (char === '\t') keys.push({ name: 'tab' })
    else if (char === '\x03') keys.push({ name: 'interrupt' })
    else if (char === '\x04') keys.push({ name: 'eof' })
    else if (char === ' ') keys.push({ name: 'space' })
    else keys.push({ name: 'char', value: char })
  }
  return keys
}

/** One offered value, as the wizard shows it. */
export interface MenuCandidate {
  value: string
  label?: string
  detail?: string
  recommended?: boolean
}

/** Everything a menu needs to draw itself and interpret an answer. */
export interface MenuConfig {
  /** First line: `host — where the page listens`. */
  title: string
  candidates: MenuCandidate[]
  /** Several checkboxes (plugins, ignore) or one choice (host, a boolean). */
  multi: boolean
  /** Values checked when the menu opens. */
  selected: readonly string[]
  /** Last line: the grammar of an answer, e.g. `Enter keeps [127.0.0.1]`. */
  footer: string
}

/** What an answer meant. */
export type MenuOutcome =
  | { kind: 'keep' }
  | { kind: 'chosen'; values: string[] }
  | { kind: 'free'; text: string }

export interface MenuState {
  cursor: number
  checked: boolean[]
  /** Text typed so far (numbers choose, anything else is a free value). */
  typed: string
  /** A one-line message shown under the title (a rejected answer, a hint). */
  note?: string
}

export function createMenuState(config: MenuConfig): MenuState {
  const selected = new Set(config.selected)
  return {
    cursor: 0,
    checked: config.candidates.map(candidate => selected.has(candidate.value)),
    typed: '',
  }
}

/** The lines a menu occupies. Used both for drawing and for line-mode output. */
export function menuLines(config: MenuConfig, state: MenuState): string[] {
  const lines = [config.title]
  if (state.note !== undefined) lines.push(`  ! ${state.note}`)
  config.candidates.forEach((candidate, index) => {
    const number = `${index + 1})`.padStart(3)
    const box = config.multi ? (state.checked[index] === true ? '[x]' : '[ ]') : ' '
    const marker = index === state.cursor ? '❯' : ' '
    const label = (candidate.label ?? candidate.value).padEnd(18)
    const detail = candidate.detail === undefined ? '' : ` ${candidate.detail}`
    const recommended = candidate.recommended === true && !config.multi ? ' (default)' : ''
    lines.push(`${marker} ${number} ${box} ${label}${detail}${recommended}`)
  })
  lines.push(`  ${config.footer}`)
  if (state.typed !== '') lines.push(`  typed: ${state.typed}`)
  return lines
}

/**
 * Interpret a typed answer. Numbers pick candidates; anything else is a free
 * value (a candidate list is a shortcut, never a restriction).
 *
 * In a multi-select the numbers **toggle**, matching the checkboxes on screen:
 * `3` on a list where 3 is unchecked checks it, and on one where it is checked
 * unchecks it. `checked` is the state the list was drawn with.
 *
 * An out-of-range number is reported as a note rather than swallowed: `17` in a
 * 5-item menu is a typo, not an address.
 */
export function interpretInput(
  config: MenuConfig,
  text: string,
  checked?: readonly boolean[],
): MenuOutcome | { kind: 'invalid'; message: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'keep' }
  const tokens = trimmed
    .split(',')
    .map(token => token.trim())
    .filter(token => token !== '')
  const numeric = tokens.length > 0 && tokens.every(token => /^\d+$/.test(token))
  if (!numeric) return { kind: 'free', text: trimmed }
  const indices: number[] = []
  for (const token of tokens) {
    const index = Number(token) - 1
    if (index < 0 || index >= config.candidates.length) {
      return {
        kind: 'invalid',
        message: `"${token}" is not on this list (1-${config.candidates.length}); type a value to use it as-is`,
      }
    }
    if (!indices.includes(index)) indices.push(index)
  }
  if (!config.multi) {
    if (indices.length > 1) return { kind: 'invalid', message: 'pick one number here' }
    return { kind: 'chosen', values: [(config.candidates[indices[0] as number] as MenuCandidate).value] }
  }
  // Multi-select toggles, and keeps the candidate order so the written file
  // reads like the list on screen (and plugin order is boot order).
  const baseline = config.candidates.map((candidate, index) =>
    checked === undefined ? config.selected.includes(candidate.value) : checked[index] === true,
  )
  for (const index of indices) baseline[index] = baseline[index] !== true
  return { kind: 'chosen', values: config.candidates.filter((_, index) => baseline[index] === true).map(c => c.value) }
}

/**
 * One key press against a menu. `outcome` is absent while the user is still
 * editing; when present, the menu is over.
 */
export function feedMenu(
  config: MenuConfig,
  state: MenuState,
  key: Key,
): { state: MenuState; outcome?: MenuOutcome } {
  const clearNote = (next: MenuState): MenuState => (next.note === undefined ? next : { ...next, note: undefined })
  switch (key.name) {
    case 'up':
      return {
        state: clearNote({ ...state, cursor: (state.cursor - 1 + config.candidates.length) % config.candidates.length }),
      }
    case 'down':
      return { state: clearNote({ ...state, cursor: (state.cursor + 1) % config.candidates.length }) }
    case 'tab':
      return { state: clearNote({ ...state, cursor: (state.cursor + 1) % config.candidates.length }) }
    case 'space': {
      if (state.typed !== '') return { state: { ...state, typed: `${state.typed} ` } }
      if (!config.multi) {
        // A single-choice menu has nothing to toggle: space means "take this one".
        const candidate = config.candidates[state.cursor] as MenuCandidate
        return { state, outcome: { kind: 'chosen', values: [candidate.value] } }
      }
      const checked = [...state.checked]
      checked[state.cursor] = checked[state.cursor] !== true
      return { state: clearNote({ ...state, checked }) }
    }
    case 'backspace':
      return { state: { ...state, typed: state.typed.slice(0, -1) } }
    case 'kill':
      return { state: { ...state, typed: '' } }
    case 'char':
      return { state: { ...state, typed: state.typed + (key.value ?? '') } }
    case 'escape':
      // Leaving a menu without an answer keeps what the file already said.
      return { state, outcome: { kind: 'keep' } }
    case 'interrupt':
      return { state, outcome: { kind: 'keep' } }
    case 'enter': {
      if (state.typed.trim() !== '') {
        const outcome = interpretInput(config, state.typed, state.checked)
        if (outcome.kind === 'invalid') return { state: { ...state, typed: '', note: outcome.message } }
        return { state, outcome }
      }
      if (config.multi) {
        const values = config.candidates.filter((_, index) => state.checked[index] === true).map(candidate => candidate.value)
        return { state, outcome: { kind: 'chosen', values } }
      }
      const candidate = config.candidates[state.cursor] as MenuCandidate
      return { state, outcome: { kind: 'chosen', values: [candidate.value] } }
    }
    case 'eof':
      return { state, outcome: { kind: 'keep' } }
  }
}

/** One answer from the terminal; `undefined` = the input ended. */
export type Answer = MenuOutcome | { kind: 'eof' }

/** What the wizard needs from a terminal. */
export interface Terminal {
  /** Whether menus can be drawn in place (stdin is a TTY). */
  readonly rich: boolean
  /** A free-text question; resolves to the line, or `undefined` when input ended. */
  line(question: string): Promise<string | undefined>
  /** A menu; resolves to what was answered, or `undefined` when input ended. */
  select(config: MenuConfig): Promise<Answer | undefined>
  close(): void
}

/** The stream subset a terminal needs (a `Readable` with optional raw mode). */
export interface TerminalInput extends NodeJS.ReadableStream {
  isTTY?: boolean
  setRawMode?(mode: boolean): void
}

/** Bytes → keys, holding back a chunk that ends mid-escape-sequence. */
class KeyDecoder {
  private carry = ''

  feed(chunk: string): Key[] {
    const text = this.carry + chunk
    this.carry = ''
    // A trailing ESC may be the start of a sequence split across chunks.
    if (text.endsWith('\x1b')) {
      this.carry = '\x1b'
      return parseKeys(text.slice(0, -1))
    }
    return parseKeys(text)
  }
}

/**
 * The terminal implementation. One stdin listener, two ways to read from it:
 * whole lines (pipes, and free-text questions) or single keys (TTY menus).
 */
export function createTerminal(input: TerminalInput, write: (text: string) => void): Terminal {
  const rich = input.isTTY === true && typeof input.setRawMode === 'function'
  const decoder = new KeyDecoder()

  let mode: 'idle' | 'line' | 'key' = 'idle'
  let lineBuffer = ''
  let linePending: string[] = []
  let lineWaiter: ((line: string | undefined) => void) | undefined
  let lineEnded = false
  let keyHandler: ((key: Key) => void) | undefined
  // Keys decoded but not yet asked for. One chunk can carry several (`0\x7f9\r`
  // is four); dropping the tail would lose keystrokes in raw mode.
  const keyQueue: Key[] = []

  const deliverLines = (): void => {
    if (lineWaiter === undefined) return
    if (linePending.length > 0) {
      const line = linePending.shift() as string
      const settle = lineWaiter
      lineWaiter = undefined
      settle(line)
      return
    }
    if (lineEnded) {
      const settle = lineWaiter
      lineWaiter = undefined
      settle(undefined)
    }
  }

  input.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (mode === 'key') {
      for (const key of decoder.feed(text)) {
        if (keyHandler === undefined) keyQueue.push(key)
        else keyHandler(key)
      }
      return
    }
    lineBuffer += text
    let index = lineBuffer.indexOf('\n')
    while (index !== -1) {
      linePending.push(lineBuffer.slice(0, index).replace(/\r$/, ''))
      lineBuffer = lineBuffer.slice(index + 1)
      index = lineBuffer.indexOf('\n')
    }
    deliverLines()
  })
  input.on('end', () => {
    if (lineBuffer !== '') {
      linePending.push(lineBuffer)
      lineBuffer = ''
    }
    lineEnded = true
    if (mode === 'key' && keyHandler !== undefined) keyHandler({ name: 'eof' })
    else if (mode === 'key') keyQueue.push({ name: 'eof' })
    deliverLines()
  })
  input.on('close', () => {
    lineEnded = true
    if (mode === 'key' && keyHandler !== undefined) keyHandler({ name: 'eof' })
    else if (mode === 'key') keyQueue.push({ name: 'eof' })
    deliverLines()
  })

  /** Read one line from the buffer, or from the stream. */
  const readLine = async (): Promise<string | undefined> => {
    if (linePending.length > 0) return linePending.shift()
    if (lineEnded) return undefined
    return await new Promise<string | undefined>((settle) => {
      lineWaiter = settle
    })
  }

  /**
   * Read one line in raw mode: characters are echoed here, because raw mode
   * turns the terminal's own echo off.
   */
  const readRawLine = async (): Promise<string | undefined> => {
    let text = ''
    for (;;) {
      const key = await readKey()
      if (key === undefined) return undefined
      switch (key.name) {
        case 'enter':
          write('\n')
          return text
        case 'backspace':
          if (text !== '') {
            text = text.slice(0, -1)
            write('\b \b')
          }
          break
        case 'kill':
          write(`\r${' '.repeat(text.length)}\r`)
          text = ''
          break
        case 'char':
          text += key.value ?? ''
          write(key.value ?? '')
          break
        case 'escape':
        case 'interrupt':
          return text
        default:
          break
      }
    }
  }

  const readKey = async (): Promise<Key | undefined> => {
    const queued = keyQueue.shift()
    if (queued !== undefined) return queued.name === 'eof' ? undefined : queued
    if (lineEnded) return undefined
    return await new Promise<Key | undefined>((settle) => {
      keyHandler = (key) => {
        keyHandler = undefined
        settle(key.name === 'eof' ? undefined : key)
      }
    })
  }

  /** Draw `lines`, then read one key; used by the menu loop. */
  const draw = (lines: string[], previous: number): number => {
    if (previous > 0) write(`\x1b[${previous}A`)
    write('\x1b[J')
    write(`${lines.join('\n')}\n`)
    return lines.length
  }

  return {
    rich,
    async line(question) {
      write(question)
      mode = rich ? 'key' : 'line'
      if (rich) input.setRawMode?.(true)
      try {
        return rich ? await readRawLine() : await readLine()
      } finally {
        if (rich) input.setRawMode?.(false)
        mode = 'idle'
        keyQueue.length = 0
      }
    },
    async select(config) {
      // A pipe cannot draw in place: print the list once and read a line.
      if (!rich) {
        const state = createMenuState(config)
        write(`${menuLines(config, state).join('\n')}\n`)
        for (;;) {
          const answer = await readLine()
          if (answer === undefined) return undefined
          const outcome = interpretInput(config, answer, state.checked)
          if (outcome.kind !== 'invalid') return outcome
          // A typo re-asks the same menu rather than silently keeping the value.
          write(`  ! ${outcome.message}\n`)
        }
      }

      let state = createMenuState(config)
      mode = 'key'
      input.setRawMode?.(true)
      let drawn = 0
      try {
        drawn = draw(menuLines(config, state), drawn)
        for (;;) {
          const key = await readKey()
          if (key === undefined) return undefined
          const next = feedMenu(config, state, key)
          state = next.state
          if (next.outcome !== undefined) {
            write('\n')
            return next.outcome
          }
          drawn = draw(menuLines(config, state), drawn)
        }
      } finally {
        input.setRawMode?.(false)
        mode = 'idle'
        // Keys typed past the answer belong to nobody: an Enter meant for this
        // menu must not confirm the next question.
        keyQueue.length = 0
      }
    },
    close() {
      input.removeAllListeners('data')
      input.setRawMode?.(false)
    },
  }
}
