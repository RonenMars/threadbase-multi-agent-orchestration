// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The streamer's ESM build named-imports the CommonJS @xterm/headless and
    // fails to load; its CommonJS build loads fine.
    alias: { '@threadbase-sh/streamer': require.resolve('@threadbase-sh/streamer') },
  },
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
