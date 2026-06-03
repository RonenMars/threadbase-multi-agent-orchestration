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
// ============================================================================

import './shared/load-env';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';
import { config } from './shared/config';

async function run() {
  const connection = await NativeConnection.connect({ address: config.address });

  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: require.resolve('./workflows'),
    activities,
    maxConcurrentActivityTaskExecutions: 10,
  });

  console.log(
    `Worker up. namespace=${config.namespace} taskQueue=${config.taskQueue} -> ${config.address}`,
  );
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
