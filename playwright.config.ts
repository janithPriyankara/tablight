import { defineConfig } from '@playwright/test';

// End-to-end tests of the built extension (run `npm run build` first). Kept out of `npm test`.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
