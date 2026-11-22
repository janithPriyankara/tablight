import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/quality/**/*.test.ts', 'tests/benchmark/**/*.test.ts'],
    environment: 'node',
  },
});
