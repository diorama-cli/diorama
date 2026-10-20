import { defineConfig } from 'tsdown'

/**
 * The renderer as a package client halves consume. React (and its JSX runtime)
 * stays external: there must be exactly one React, and therefore exactly one
 * set of React contexts, in a page.
 */
export default defineConfig({
  // Two entries: the primitives every half imports, and the artwork + installer
  // the shell alone imports (docs/m7/spec.md §3). Keeping them apart is what
  // keeps ~170 KB of icon data out of every client half.
  entry: { index: 'src/index.ts', icons: 'src/icons/install.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: true,
  jsx: 'automatic',
  deps: { neverBundle: [/^react(\/|$)/] },
})
