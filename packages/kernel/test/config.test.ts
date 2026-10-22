import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ConfigError,
  configWritePath,
  defaultConfig,
  formatFileConfig,
  mergeConfig,
  parseConfigFile,
  patchFileConfig,
  readFileConfig,
  resolveConfig,
  writeFileConfig,
  type FileConfig,
  type ResolveOptions,
} from '../src/server/config.ts'

test('config: defaults match contract §4.1', () => {
  const defaults = defaultConfig()
  assert.equal(defaults.host, '127.0.0.1')
  assert.equal(defaults.port, 0)
  assert.deepEqual(defaults.ignore, ['.git', 'node_modules'])
  assert.deepEqual(defaults.watch, { debounceMs: 300, enabled: true, maxDirectories: 64 })
  // Every built-in client plugin, in boot order (contract.md §1: the selection
  // is the boot order). `fs`/`git`/`search` are kernel services, not client
  // pieces (contract.md §3.1, §3.2, §3.9): they never appear in the page's
  // boot graph.
  assert.deepEqual(defaults.plugins, [
    'slots',
    'layout',
    'file-tree',
    'tabs',
    'renderer-registry',
    'plaintext',
    'markdown',
    'code',
    'image',
    'pdf',
    'html',
    'palette',
    'help',
    'theme',
    'git-changes',
    'search-view',
  ])
})

test('config: precedence is CLI > file > default', () => {
  const file = parseConfigFile(
    ['host = "0.0.0.0"', 'port = 4000', 'plugins = ["slots", "layout"]', 'ignore = ["dist"]', '[watch]', 'debounceMs = 50'].join('\n'),
    'test',
  )
  assert.deepEqual(mergeConfig(file), {
    host: '0.0.0.0',
    port: 4000,
    plugins: ['slots', 'layout'],
    ignore: ['dist'],
    // maxDirectories has no file entry above: the default survives the merge.
    watch: { debounceMs: 50, enabled: true, maxDirectories: 64 },
    // No `[git]` table either: repository discovery keeps its defaults.
    git: { maxDepth: 3, maxRepos: 32 },
  })
  // CLI wins field by field; `--all` empties the ignore list.
  const merged = mergeConfig(file, { port: 0, host: '127.0.0.1', all: true })
  assert.equal(merged.port, 0)
  assert.equal(merged.host, '127.0.0.1')
  assert.deepEqual(merged.ignore, [])
  assert.deepEqual(merged.plugins, ['slots', 'layout'])
})

test('config: watch.maxDirectories is a 1–4096 integer, merged like every other field', () => {
  const file = parseConfigFile(['[watch]', 'maxDirectories = 8'].join('\n'), 'w.toml')
  assert.equal(mergeConfig(file).watch.maxDirectories, 8)
  for (const bad of ['0', '4097', '1.5', '"64"']) {
    assert.throws(
      () => parseConfigFile(['[watch]', `maxDirectories = ${bad}`].join('\n'), 'w.toml'),
      /w\.toml: "watch\.maxDirectories" must be an integer 1–4096/,
      bad,
    )
  }
})

test('config: a syntax error and unknown keys fail loud, naming the file', () => {
  assert.throws(() => parseConfigFile('port = ', 'diorama.toml'), (error: unknown) => {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /diorama\.toml: invalid TOML/)
    return true
  })
  assert.throws(() => parseConfigFile('prot = 1', 'x.toml'), /x\.toml: unknown key "prot"/)
  assert.throws(() => parseConfigFile('[watch]\ninterval = 1', 'x.toml'), /unknown key "watch\.interval"/)
})

test('config: field types and ranges are validated', () => {
  assert.throws(() => parseConfigFile('port = 70000', 'x'), /"port" must be an integer 0–65535/)
  assert.throws(() => parseConfigFile('port = "80"', 'x'), /"port" must be an integer/)
  assert.throws(() => parseConfigFile('host = ""', 'x'), /"host" must be a non-empty string/)
  assert.throws(() => parseConfigFile('ignore = "dist"', 'x'), /"ignore" must be an array of strings/)
  assert.throws(() => parseConfigFile('[watch]\ndebounceMs = -1', 'x'), /"watch.debounceMs"/)
  assert.throws(() => parseConfigFile('[watch]\nenabled = "yes"', 'x'), /"watch.enabled" must be a boolean/)
})

function files(contents: Record<string, string>): ResolveOptions {
  return {
    root: '/srv/project',
    home: '/home/u/.diorama',
    exists: path => path in contents,
    readFile: path => {
      const text = contents[path]
      if (text === undefined) throw new Error('missing')
      return text
    },
  }
}

test('config: the served directory wins over $DIORAMA_HOME; none means defaults', () => {
  const both = files({
    '/srv/project/diorama.toml': 'port = 1111',
    '/home/u/.diorama/diorama.toml': 'port = 2222',
  })
  const fromProject = resolveConfig(both)
  assert.equal(fromProject.config.port, 1111)
  assert.equal(fromProject.origin.path, '/srv/project/diorama.toml')

  const fromHome = resolveConfig(files({ '/home/u/.diorama/diorama.toml': 'port = 2222' }))
  assert.equal(fromHome.config.port, 2222)
  assert.equal(fromHome.origin.path, '/home/u/.diorama/diorama.toml')

  const none = resolveConfig(files({}))
  assert.deepEqual(none.config, defaultConfig())
  assert.equal(none.origin.path, undefined)
})

test('config: --config points at one file and must exist', () => {
  const options = { ...files({ '/etc/dio.toml': 'host = "10.0.0.1"' }), configPath: '/etc/dio.toml' }
  assert.equal(resolveConfig(options).config.host, '10.0.0.1')
  assert.throws(() => resolveConfig({ ...files({}), configPath: '/nope.toml' }), /no such file/)
})

// --- writing (contract.md §4.2) --------------------------------------------

test('config: a patch touches only the keys it names', () => {
  const base = parseConfigFile(
    ['host = "0.0.0.0"', 'port = 4000', '[watch]', 'debounceMs = 50', 'enabled = false'].join('\n'),
    'test',
  )
  const patched = patchFileConfig(base, { port: 8080, 'watch.enabled': true })
  assert.deepEqual(patched, {
    host: '0.0.0.0',
    port: 8080,
    // The untouched watch field survives; the table is not replaced wholesale.
    watch: { debounceMs: 50, enabled: true },
  })
  // The input is not mutated: `set` reads a file and writes another one.
  assert.equal(base.port, 4000)
  assert.equal(base.watch?.enabled, false)
})

test('config: `undefined` deletes a key, and an emptied watch table disappears', () => {
  const base: FileConfig = { host: '0.0.0.0', watch: { enabled: false } }
  assert.deepEqual(patchFileConfig(base, { host: undefined }), { watch: { enabled: false } })
  assert.deepEqual(patchFileConfig(base, { 'watch.enabled': undefined }), { host: '0.0.0.0' })
  assert.deepEqual(patchFileConfig(base, { 'watch.enabled': undefined, host: undefined }), {})
})

test('config: a patch is held to the file schema, and unknown keys name the known ones', () => {
  assert.throws(() => patchFileConfig({}, { port: 70_000 }), /"port" must be an integer 0–65535/)
  assert.throws(() => patchFileConfig({}, { host: '' }), /"host" must be a non-empty string/)
  assert.throws(() => patchFileConfig({}, { 'watch.nope': 1 }), /unknown key "watch.nope".*watch\.debounceMs/)
  assert.throws(() => patchFileConfig({}, { plugin: [] }), /unknown key "plugin"/)
  // An empty array is a value, not a deletion: `ignore = []` hides nothing.
  assert.deepEqual(patchFileConfig({ ignore: ['.git'] }, { ignore: [] }), { ignore: [] })
})

test('config: the written file keeps the documented key order and round-trips', () => {
  const config: FileConfig = {
    watch: { maxDirectories: 8 },
    ignore: [],
    plugins: ['slots', 'layout'],
    port: 8080,
    host: '127.0.0.1',
  }
  const text = formatFileConfig(config)
  assert.equal(
    text,
    ['host = "127.0.0.1"', 'port = 8080', 'plugins = [ "slots", "layout" ]', 'ignore = []', '', '[watch]', 'maxDirectories = 8', ''].join('\n'),
  )
  // What we write, we can read: the same values come back.
  assert.deepEqual(parseConfigFile(text, 'written'), {
    host: '127.0.0.1',
    port: 8080,
    plugins: ['slots', 'layout'],
    ignore: [],
    watch: { maxDirectories: 8 },
  })
  // Nothing chosen → nothing written (not a file full of defaults).
  assert.equal(formatFileConfig({}), '')
  assert.equal(formatFileConfig({ watch: {} }), '')
})

test('config: writing creates the parent directory and reports a write failure by name', () => {
  const made: string[] = []
  const written: { path: string; text: string }[] = []
  const result = writeFileConfig({
    path: '/home/u/.diorama/diorama.toml',
    config: { port: 1 },
    mkdir: path => made.push(path),
    writeFile: (path, text) => written.push({ path, text }),
  })
  assert.deepEqual(made, ['/home/u/.diorama'])
  assert.deepEqual(written, [{ path: '/home/u/.diorama/diorama.toml', text: 'port = 1\n' }])
  assert.equal(result.text, 'port = 1\n')

  assert.throws(
    () => writeFileConfig({ path: '/nope/x.toml', config: {}, mkdir: () => {}, writeFile: () => { throw new Error('EACCES: denied') } }),
    /\/nope\/x\.toml: cannot write \(EACCES: denied\)/,
  )
})

test('config: a missing file reads as an empty config, a broken one fails loud', () => {
  assert.deepEqual(readFileConfig({ path: '/none.toml', exists: () => false }), {})
  assert.deepEqual(readFileConfig({ path: '/x.toml', exists: () => true, readFile: () => 'port = 9' }), { port: 9 })
  assert.throws(() => readFileConfig({ path: '/x.toml', exists: () => true, readFile: () => 'port = ' }), /\/x\.toml: invalid TOML/)
})

test('config: writes default to $DIORAMA_HOME, and only a named directory or file moves them', () => {
  assert.equal(configWritePath({ home: '/home/u/.diorama' }), '/home/u/.diorama/diorama.toml')
  assert.equal(configWritePath({ home: '/home/u/.diorama', root: '/srv/project' }), '/srv/project/diorama.toml')
  assert.equal(configWritePath({ home: '/home/u/.diorama', root: '/srv/project', configPath: '/etc/dio.toml' }), '/etc/dio.toml')
})

test('config: a written file is what serving picks up next', () => {
  const path = '/srv/project/diorama.toml'
  const written = writeFileConfig({ path, config: { host: '0.0.0.0', ignore: [] }, mkdir: () => {}, writeFile: () => {} })
  const resolved = resolveConfig({
    root: '/srv/project',
    home: '/home/u/.diorama',
    exists: candidate => candidate === path,
    readFile: () => written.text,
  })
  assert.equal(resolved.origin.path, path)
  assert.equal(resolved.config.host, '0.0.0.0')
  assert.deepEqual(resolved.config.ignore, [])
  assert.equal(resolved.config.port, 0)
})
