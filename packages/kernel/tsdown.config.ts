import { defineConfig } from 'tsdown'

/**
 * Kernel bundles: `types` (an empty runtime module for the type entry),
 * `server` (Node: HTTP + fs + Cordis) and `client` (browser: fs transport,
 * Cordis boot, page services). Declarations are emitted separately by `tsc`
 * (tsconfig.emit.json) so ambient module augmentations survive.
 */
export default defineConfig([
  {
    entry: { types: 'src/types.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    fixedExtension: false,
    target: 'es2022',
    dts: false,
    sourcemap: true,
  },
  {
    entry: { server: 'src/server/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    fixedExtension: false,
    target: 'node22',
    dts: false,
    sourcemap: true,
    deps: { neverBundle: ['cordis'] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    fixedExtension: false,
    target: 'es2022',
    dts: false,
    sourcemap: true,
    deps: { neverBundle: ['cordis'] },
  },
])
