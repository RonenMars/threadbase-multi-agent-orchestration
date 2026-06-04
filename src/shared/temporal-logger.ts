// Adapter that lets Temporal's Runtime use our pino logger.
//
// Temporal's Logger interface expects (message: string, meta?: object) per
// method. Pino accepts (meta, message?) — so we swap the argument order in
// a thin wrapper. The metadata Temporal passes (sdkComponent, workflowId,
// taskQueue, etc.) ends up as structured pino fields.
//
// This wrapper is what we pass to `Runtime.install({ logger: ... })` in
// worker.ts. Workflow code that calls `log.info(...)` from
// `@temporalio/workflow` is routed through Temporal's SDK, which then calls
// this adapter, which logs via pino.

import type {
  Logger as TemporalLogger,
  LogLevel,
  LogMetadata,
} from '@temporalio/common';
import type { Logger as PinoLogger } from 'pino';

export function pinoToTemporalLogger(pinoLogger: PinoLogger): TemporalLogger {
  const wrap = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, meta?: LogMetadata): void => {
      if (meta) {
        pinoLogger[level](meta, message);
      } else {
        pinoLogger[level](message);
      }
    };

  return {
    trace: wrap('trace'),
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    log(level: LogLevel, message: string, meta?: LogMetadata): void {
      const fn = (this as TemporalLogger)[
        level.toLowerCase() as 'trace' | 'debug' | 'info' | 'warn' | 'error'
      ];
      if (typeof fn === 'function') {
        fn.call(this, message, meta);
      } else {
        // Unknown level — fall back to info.
        this.info(`[${level}] ${message}`, meta);
      }
    },
  };
}
