import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extensionOf, isTextualMime, mimeOf } from '../src/shared/mime.ts'

/**
 * The extension table (contract.md §5.1, §4).
 *
 * Two readers share it: the renderer matcher (bare types) and the raw-bytes
 * route (types a browser can show). The failure it exists to prevent is the
 * one a reader sees as "opening this file downloaded it" — a source file the
 * table did not know, answered as `application/octet-stream`.
 */

test('extensionOf reads the last dot, and a dotfile has none', () => {
  assert.equal(extensionOf('src/app.ts'), 'ts')
  assert.equal(extensionOf('a.b.c.JSON'), 'json')
  assert.equal(extensionOf('Makefile'), '')
  // A leading dot starts the name, not an extension: `.gitignore` has no ext.
  assert.equal(extensionOf('.gitignore'), '')
  assert.equal(extensionOf('dir/.env'), '')
  // A trailing dot is not an extension either.
  assert.equal(extensionOf('weird.'), '')
})

test('source files are text, so a browser shows them instead of saving them', () => {
  // The reported symptom: "many code files open as a download".
  const text = [
    'a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs',
    'a.py', 'a.rb', 'a.go', 'a.rs', 'a.java', 'a.kt', 'a.swift',
    'a.c', 'a.h', 'a.cpp', 'a.hpp', 'a.cs', 'a.php', 'a.lua', 'a.dart',
    'a.sh', 'a.bash', 'a.zsh', 'a.ps1', 'a.bat',
    'a.sql', 'a.graphql', 'a.proto', 'a.tf', 'a.nix', 'a.cmake', 'a.mk',
    'a.vue', 'a.svelte', 'a.astro', 'a.jl', 'a.ex', 'a.hs', 'a.clj', 'a.zig',
  ]
  for (const path of text) {
    const type = mimeOf(path)
    assert.notEqual(type, 'application/octet-stream', `${path} must not be an opaque download`)
    assert.ok(isTextualMime(type), `${path} -> ${type} should be textual`)
  }
})

test('data and config files are text too', () => {
  for (const path of ['a.json', 'a.json5', 'a.jsonl', 'a.yaml', 'a.yml', 'a.toml', 'a.ini', 'a.cfg', 'a.xml', 'a.csv', 'a.tsv', 'a.md', 'a.rst']) {
    assert.ok(isTextualMime(mimeOf(path)), `${path} -> ${mimeOf(path)}`)
  }
})

test('dotfiles are configuration, and configuration is text', () => {
  // They have no extension, which used to mean "unknown" — an opaque download.
  for (const path of ['.gitignore', '.env', '.npmrc', '.editorconfig', 'dir/.gitattributes']) {
    assert.ok(isTextualMime(mimeOf(path)), `${path} -> ${mimeOf(path)}`)
  }
})

test('media keeps its own type, without a charset', () => {
  assert.equal(mimeOf('a.png'), 'image/png')
  assert.equal(mimeOf('a.jpeg'), 'image/jpeg')
  assert.equal(mimeOf('a.svg'), 'image/svg+xml')
  assert.equal(mimeOf('a.pdf'), 'application/pdf')
  assert.equal(mimeOf('a.mp4'), 'video/mp4')
  assert.equal(mimeOf('a.mp3'), 'audio/mpeg')
  assert.equal(mimeOf('a.woff2'), 'font/woff2')
  assert.equal(isTextualMime(mimeOf('a.png')), false)
  assert.equal(isTextualMime(mimeOf('a.pdf')), false)
})

test('files known by name are text, whatever their extension', () => {
  // `Makefile` has no extension: it used to be an opaque download while
  // `makefile.mk` was text — the same file, two answers.
  assert.equal(mimeOf('Makefile'), 'text/x-makefile')
  assert.equal(mimeOf('GNUmakefile'), 'text/x-makefile')
  assert.equal(mimeOf('Dockerfile'), 'text/x-dockerfile')
  // `CMakeLists.txt` has a real extension, and `.txt` is the better answer.
  assert.equal(mimeOf('CMakeLists.txt'), 'text/plain')
  assert.equal(mimeOf('LICENSE'), 'text/plain')
  assert.equal(mimeOf('README'), 'text/plain')
  // A variant keeps the name's type...
  assert.equal(mimeOf('Dockerfile.dev'), 'text/x-dockerfile')
  assert.equal(mimeOf('Makefile.am'), 'text/x-makefile')
  // ...unless the suffix is itself a known extension, which is the better answer.
  assert.equal(mimeOf('Gemfile.lock'), 'text/plain')
})

test('a type nobody knows stays an opaque download', () => {
  assert.equal(mimeOf('a.unknownext'), 'application/octet-stream')
  assert.equal(mimeOf('blob.bin'), 'application/octet-stream')
  assert.equal(mimeOf('mystery'), 'application/octet-stream')
})

test('the table stays parameters-free (a matcher compares bare types)', () => {
  // `rawContentType` adds `charset`; `mimeOf` must not, or every `mime` matcher
  // (`image/*`, `text/plain`) would stop matching (contract §5.1).
  for (const path of ['a.txt', 'a.json', 'a.png', 'a.html']) {
    assert.equal(mimeOf(path).includes(';'), false, path)
  }
})
