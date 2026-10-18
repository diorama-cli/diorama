import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { main: 'src/run.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: false,
  clean: true,
  sourcemap: true,
  deps: { neverBundle: [/^diorama-/] },
})
