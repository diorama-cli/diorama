import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * A client half has two artifacts from one source (docs/m0/spec.md §10.3):
 * - `lib/index.mjs`  - ordinary ESM, what the Node-side loader imports;
 * - `lib/client.cjs` - a closure factory registered with the page's module
 *                      loader (`window.__ModuleLoader__.load({id, factory})`).
 *
 * The half is fully self-contained (React stays external so the page keeps one
 * React). It never needs to share a module *identity* with the shell: page
 * state travels through the kernel's global page bridge, which both sides read.
 */
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'))
const id = JSON.stringify(manifest.diorama.id)

export default defineConfig({
  // A single React forces a single JSX transform in both artifacts.
  plugins: [react()],
  build: {
    emptyOutDir: false,
    outDir: 'lib',
    sourcemap: true,
    lib: {
      entry: join(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
      name: 'dioramaHalf',
    },
    rollupOptions: {
      external: [/^react(\/|$)/],
      output: [
        { entryFileNames: 'index.mjs', format: 'es' },
        {
          entryFileNames: 'client.cjs',
          format: 'cjs',
          banner: ';(function () {\n' +
            "  'use strict'\n" +
            '  window.__ModuleLoader__ = window.__ModuleLoader__ || ' +
            '{ load: function (registration) { (window.__diorama_halves__ = window.__diorama_halves__ || []).push(registration) } }\n' +
            '  window.__ModuleLoader__.load({\n' +
            '    id: ' + id + ',\n' +
            '    factory: function (require) {\n' +
            '      var module = { exports: {} }\n' +
            '      var exports = module.exports\n',
          footer: '\n      return module.exports\n    },\n  })\n})()\n',
        },
      ],
    },
  },
})
