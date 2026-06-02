// ============================================================================
// CLIENT helper — import this into your Threadbase backend.
//
// The backend's only jobs are to START a workflow when a message arrives and to
// OBSERVE it (query its stage, await its result). It never runs agent logic.
// ============================================================================

import { Connection, Client } from '@temporalio/client';
import { taskPipelineWorkflow, stageQuery } from './workflows';
import { config } from './shared/config';
import type { Task, Result } from './shared/types';

let client: Client | undefined;

export async function getClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({ address: config.address });
    client = new Client({ connection, namespace: config.namespace });
  }
  return client;
}

/** Start the pipeline for a task. Returns immediately; work runs durably. */
export async function startTask(task: Task): Promise<string> {
  const c = await getClient();
  const handle = await c.workflow.start(taskPipelineWorkflow, {
    taskQueue: config.taskQueue,
    workflowId: `task-${task.id}`, // de-dupes: the same id won't double-run
    args: [task],
  });
  return handle.workflowId;
}

/** Ask a running workflow what stage it's in (queued/processing/review/...). */
export async function getStage(taskId: string): Promise<string> {
  const c = await getClient();
  return c.workflow.getHandle(`task-${taskId}`).query(stageQuery);
}

/** Block until the pipeline finishes and return its result. */
export async function awaitResult(taskId: string): Promise<Result> {
  const c = await getClient();
  return c.workflow.getHandle(`task-${taskId}`).result();
}
