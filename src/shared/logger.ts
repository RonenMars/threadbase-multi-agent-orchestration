// Centralized pino logger for non-workflow code.
//
// Use this from worker.ts, activities, client.ts, and scripts. For WORKFLOW
// code, use `import { log } from '@temporalio/workflow'` instead — workflow
// code runs under deterministic replay and direct logger calls would emit
// duplicates on every replay.
//
// Config:
//   LOG_LEVEL = trace | debug | info (default) | warn | error | fatal
//
// Output is JSON to stdout (pino default). For human-readable dev output,
// pipe to pino-pretty:  npm run worker | npx pino-pretty
// Or use the `worker:pretty` script which does this for you.

import pino, { type Logger } from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger: Logger = pino({
  level,
  base: {
    // Identify which process emitted the log when both worker and scripts
    // run together. Override via PROCESS_NAME env var if needed.
    proc: process.env.PROCESS_NAME ?? 'tb-multi-agent',
  },
  // Use ISO timestamps for log aggregator friendliness. pino's default is
  // an integer ms epoch which is harder to read at a glance.
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Build a child logger pre-populated with session / turn context. Use this
 * in any code path that handles a single session or turn — the
 * `sessionId` / `turnId` fields will then appear on every line.
 */
export function withTurn(sessionId: string, turnId?: string): Logger {
  return turnId
    ? logger.child({ sessionId, turnId })
    : logger.child({ sessionId });
}
