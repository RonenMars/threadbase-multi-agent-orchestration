// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'packages/**'],
    // Temporal TestWorkflowEnvironment spins up a real Temporal in-process —
    // give it room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
