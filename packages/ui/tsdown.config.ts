import { defineConfig } from 'tsdown'

/**
 * The renderer as a package client halves consume. React (and its JSX runtime)
 * stays external: there must be exactly one React, and therefore exactly one
 * set of React contexts, in a page.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
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
