/**
 * Playwright E2E config (dsh-vscode-sidebar).
 * Runs the REAL webview build (media/main.js) in headless Chromium against
 * the REAL extension host code running in Node (tests/e2e/harness.ts, built
 * by `node esbuild.config.mjs --e2e`) and a REAL self-spawned dsh host on an
 * isolated $DSH_HOME (port 3200+, never 3080 — AGENTS.md).
 * Run: `npm run test:e2e` (builds the webview + harness first).
 */

import { defineConfig } from 'playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: '.temp/e2e-artifacts',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
