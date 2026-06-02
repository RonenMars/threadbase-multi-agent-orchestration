// ============================================================================
// WORKFLOW = the deterministic orchestration / pipeline.
//
// This code reads like ordinary sequential logic, but every `await` is a
// durable checkpoint recorded in Temporal's event history. Crash mid-pipeline
// and a new worker replays the history to resume exactly where it left off.
//
// HARD RULE: workflow code must be deterministic. No direct network/DB calls,
// no Date.now(), no Math.random(), no env reads. All of that goes in activities
// (called via the proxy below) so Temporal can record and replay their results.
// ============================================================================

import { proxyActivities, defineQuery, setHandler } from '@temporalio/workflow';
import type * as activities from './activities';
import type { Task, Result } from './shared/types';

const { processTask, reviewTask, productSignOff } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});

// Lets the backend ask "what stage is this task in?" live, without a DB.
export const stageQuery = defineQuery<string>('stage');

const MAX_REWORK = 2;

export async function taskPipelineWorkflow(task: Task): Promise<Result> {
  let stage = 'queued';
  setHandler(stageQuery, () => stage);

  stage = 'processing';
  let draft = await processTask(task);

  stage = 'review';
  let review = await reviewTask(draft);

  // Re-work loop: if the reviewer rejects, send it back to the worker agent
  // with the reviewer's notes as added context.
  let reworkAttempts = 0;
  while (!review.approved && reworkAttempts < MAX_REWORK) {
    reworkAttempts += 1;
    stage = `rework-${reworkAttempts}`;
    draft = await processTask({
      ...task,
      context: `${task.context ?? ''}\n\nReviewer notes to address: ${review.notes}`.trim(),
    });
    stage = 'review';
    review = await reviewTask(draft);
  }

  stage = 'sign-off';
  await productSignOff(draft, review);

  stage = 'done';
  return { taskId: task.id, content: draft.content, review, reworkAttempts };
}
