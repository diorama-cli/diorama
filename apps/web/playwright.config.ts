import { defineConfig } from '@playwright/test'

/**
 * M0 acceptance tests (docs/plan.md): the suite drives the *real* CLI process
 * and a real browser. Each spec starts its own `diorama` instance on a free
 * port against a generated directory, so no test depends on another.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
})
