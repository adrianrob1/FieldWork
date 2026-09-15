import { defineConfig } from '@playwright/test';

// Browser acceptance tests for the Sidecar web UI. These run against the built
// server (npm run test:browser builds first) and are deliberately excluded from
// the Vitest suite: only *.e2e.ts files are collected here.
export default defineConfig({
  testDir: './tests/browser',
  testMatch: /.*\.e2e\.ts/,
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    video: 'off',
    trace: 'off',
    screenshot: 'off',
    viewport: { width: 1280, height: 800 },
  },
});
