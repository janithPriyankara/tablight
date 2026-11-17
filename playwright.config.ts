import { defineConfig } from '@playwright/test';

// End-to-end tests of the built extension (run `npm run build` first). Kept out of `npm test`.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // Each spec file starts its own Chromium profile (temp dir) and page server (random port), and runs
  // its tests in order, so files can run side by side. E2E_WORKERS sets how many at once.
  workers: process.env.E2E_WORKERS ?? '50%',
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
