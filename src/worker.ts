// ============================================================================
// WORKER = the long-running agent process. This IS your agent pool.
//
// It connects to the Temporal server, polls the Task Queue, and runs both the
// workflow code and the activities (the AI agents). Run several replicas to
// scale; Temporal load-balances tasks across all workers on the same queue.
//
// Run it:  npm run worker
// ============================================================================

import './shared/load-env'; // MUST be first — loads .env before activities.ts constructs Anthropic()
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
    // Cap concurrent LLM calls per worker to control cost / rate limits.
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
