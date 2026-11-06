import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/slow/**/*.test.ts'], testTimeout: 900000 },
});
