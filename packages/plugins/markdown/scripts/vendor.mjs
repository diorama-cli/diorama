#!/usr/bin/env node
/**
 * Copy the two vendored libraries this piece serves at runtime into `lib/vendor`.
 *
 * Why they are files next to the client half instead of imports:
 *
 * - **A client half is a self-contained closure** (docs/m0/spec.md §10.3): every
 *   import is bundled into `lib/client.cjs`, which every page load pays for.
 *   KaTeX is ~270 KB minified and Mermaid is ~3.5 MB — a document that contains
 *   neither must not download them.
 * - **They need files of their own.** KaTeX's stylesheet points at 20 font files;
 *   a bundled copy would have to inline or rewrite them. Served from
 *   `/plugins/markdown/vendor/` (contract.md §5.1) they resolve relative to the
 *   stylesheet exactly as the package ships them.
 *
 * The half therefore loads them **on demand**: `enhance.ts` injects
 * `vendor/katex.min.js` when a document has `$…$`, and `vendor/mermaid.min.js`
 * when it has a ```mermaid fence. Both write a global (`katex`, `mermaid`).
 *
 * Run by `pnpm build` after the Vite build; idempotent (the directory is
 * replaced). `scripts/assemble-package.mjs` carries `lib/vendor` into the
 * published CLI, because the browser asks the same URL there.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageDir = join(dirname(new URL(import.meta.url).pathname), '..')
const vendorDir = join(packageDir, 'lib', 'vendor')

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(join(vendorDir, 'fonts'), { recursive: true })

/** The `dist` directory of a dependency (its exports map allows the deep path). */
function distOf(specifier) {
  return dirname(require.resolve(specifier))
}

const katexDist = distOf('katex/dist/katex.min.css')
copyFileSync(join(katexDist, 'katex.min.css'), join(vendorDir, 'katex.min.css'))
copyFileSync(join(katexDist, 'katex.min.js'), join(vendorDir, 'katex.min.js'))
// woff2 only: every browser that runs this page reads it, and the stylesheet
// lists woff2 first, so the older formats are never requested.
let fonts = 0
for (const file of readdirSync(join(katexDist, 'fonts'))) {
  if (!file.endsWith('.woff2')) continue
  copyFileSync(join(katexDist, 'fonts', file), join(vendorDir, 'fonts', file))
  fonts++
}

const mermaidDist = distOf('mermaid/dist/mermaid.min.js')
copyFileSync(join(mermaidDist, 'mermaid.min.js'), join(vendorDir, 'mermaid.min.js'))

process.stdout.write(`  lib/vendor: katex.min.css, ${fonts} fonts, mermaid.min.js\n`)
