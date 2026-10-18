import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The shell is a static bundle: one `index.html` and its assets, served by the
 * CLI from the same origin as `/plugin.json` and the client halves.
 *
 * Client halves are loaded at runtime (closure factories), not statically: the
 * shell holds its own copy of the renderer, and the halves read page state from
 * the kernel's page bridge, so cross-bundle renderer identity never matters.
 */

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // `vite dev` talks to a running `diorama` server for the API routes.
    proxy: {
      '/api': process.env.DIORAMA_DEV_SERVER ?? 'http://127.0.0.1:8000',
      '/plugin.json': process.env.DIORAMA_DEV_SERVER ?? 'http://127.0.0.1:8000',
    },
  },
})
