// ============================================================================
// WORKER = the long-running agent process. THIS is your agent pool.
//
// It connects to Temporal, polls the Task Queue, and runs:
// - The long-lived `orchestratorWorkflow` (one per session, holds the signal queue).
// - The one-shot `turnWorkflow` (one per user message, drives the agent pipeline).
// - All activities: `processTask`, `reviewTask`, `productSignOff`, `sendProgressEvent`.
//
// Run several replicas to scale; Temporal load-balances across the shared
// Task Queue. Run:  npm run worker
//
// For pretty-printed local logs:  npm run worker:pretty
// ============================================================================

import './shared/load-env';
import { Runtime, Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';
import { config } from './shared/config';
import { logger } from './shared/logger';
import { pinoToTemporalLogger } from './shared/temporal-logger';

async function run() {
  // Install pino as the Runtime logger BEFORE creating the Worker. This
  // routes SDK-side logs (and workflow `log.info(...)` calls) through pino
  // so everything emits in a single JSON stream.
  Runtime.install({ logger: pinoToTemporalLogger(logger) });

  logger.info(
    {
      address: config.address,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      model: config.model,
    },
    'connecting to temporal',
  );

  const connection = await NativeConnection.connect({ address: config.address });

  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: require.resolve('./workflows'),
    activities,
    maxConcurrentActivityTaskExecutions: 10,
  });

  logger.info(
    {
      address: config.address,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
    },
    'worker up',
  );

  // Graceful shutdown — Temporal Workers handle SIGINT/SIGTERM via
  // `shutdownSignals` (default), so this is purely for our own logs.
  const onShutdown = (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
  };
  process.on('SIGINT', () => onShutdown('SIGINT'));
  process.on('SIGTERM', () => onShutdown('SIGTERM'));

  await worker.run();
  logger.info('worker stopped cleanly');
}

run().catch((err) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
