// src/worker.ts
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
