import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { main: 'src/main.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  clean: true,
  // No source maps in the published build: `lib/` is 2.3 MB of inlined halves
  // and the maps alone double it. A checkout keeps them via the beta entry.
  sourcemap: false,
  deps: {
    // The published package is ONE install (docs/m8/spec.md §3): the kernel,
    // the UI primitives and every built-in plugin are inlined here. Without
    // this they would be externalized (they are listed in `dependencies`) and
    // `npm i -g` would ask for 17 packages that no longer exist separately.
    alwaysBundle: [/^diorama-/],
    // `cordis` is a plain third-party dependency: resolved from `node_modules`.
    neverBundle: ['cordis'],
  },
})
