import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ConfigError,
  defaultConfig,
  mergeConfig,
  parseConfigFile,
  resolveConfig,
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
