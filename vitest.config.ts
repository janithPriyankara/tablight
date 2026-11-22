import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/quality/**/*.test.ts', 'tests/benchmark/**/*.test.ts'],
    environment: 'node',
    // Active with --coverage only (CI's unit stage). Thresholds sit just under the measured level (92.4% statements,
    // 88.6% branches, 88.5% functions, 95.3% lines at the time of writing), so coverage can rise but never quietly fall.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/ui/mock/**'], // the dev-only UI preview harness (fake embedder, fixtures); never shipped
      reporter: ['text-summary', 'json-summary', 'lcov', 'cobertura'],
      reportsDirectory: 'reports/coverage',
      thresholds: { statements: 92, branches: 88, functions: 88, lines: 95 },
    },
  },
});
