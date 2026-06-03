// src/workflows/turn.ts
//
// ONE-SHOT child workflow per user turn. Drives the worker → reviewer →
// (rework loop, capped at 2) → sign-off pipeline.
//
// Determinism rules:
// - `eventId` is generated via workflow.uuid4() — replay-safe (spec §7.6).
// - `timestamp` is taken via workflow.now() (Temporal-safe replacement for Date.now).
// - `seq` is incremented from a per-turn counter — no global mutable state.

import {
  proxyActivities,
  setHandler,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';
import type { ProgressEvent, AgentOutputPayload } from '@threadbase/agent-types';

import type * as agentActivities from '../activities/agents';
import type * as progressActivities from '../activities/progress';
import type { Draft, Review, Task, TurnInput } from '../shared/types';
import { stageQuery } from './signals';
import { createSeq } from './eventSeq';

const { processTask, reviewTask, productSignOff } = proxyActivities<typeof agentActivities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});

const { sendProgressEvent } = proxyActivities<typeof progressActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 1 }, // helper has its own retry window
});

const MAX_REWORK = 2;

export interface TurnResult {
  taskId: string; // same as turnId
  content: string;
  review: Review;
  reworkAttempts: number;
  reviewerOverruled: boolean;
}

function nowSeconds(): number {
  // workflow.now() returns a Date that's deterministic under replay.
  return Math.floor(Date.now() / 1000);
}

export async function turnWorkflow(input: TurnInput): Promise<TurnResult> {
  const { sessionId, turnId, prompt, conversationHistory } = input;
  let stage = 'processing';
  setHandler(stageQuery, () => stage);

  const seq = createSeq();

  async function emit(partial: Omit<ProgressEvent, 'sessionId' | 'turnId' | 'eventId' | 'seq' | 'timestamp'>): Promise<void> {
    const ev: ProgressEvent = {
      ...partial,
      sessionId,
      turnId,
      eventId: uuid4(),
      seq: seq(),
      timestamp: nowSeconds(),
    };
    await sendProgressEvent(ev);
  }

  // Build the initial Task with the latest user prompt + a string-formed history.
  // History is stitched here (deterministic) rather than inside an activity, so
  // the same Task arrives across activity retries.
  const historyText = conversationHistory
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n');

  const baseTask: Task = {
    id: turnId,
    sessionId,
    prompt,
    context: historyText || undefined,
  };

  // ─── processing ────────────────────────────────────────────────────────
  await emit({ type: 'stage_transition', stage: 'processing' });
  let draft: Draft = await processTask(baseTask);
  await emit({
    type: 'agent_output',
    stage: 'processing',
    payload: { content: draft.content } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
  });

  // ─── review (+ optional rework loop) ───────────────────────────────────
  stage = 'review';
  await emit({ type: 'stage_transition', stage: 'review' });
  let review: Review = await reviewTask(draft);
  await emit({
    type: 'agent_output',
    stage: 'review',
    payload: { content: review.notes || (review.approved ? 'approved' : '') } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
  });

  let reworkAttempts = 0;
  while (!review.approved && reworkAttempts < MAX_REWORK) {
    reworkAttempts += 1;
    stage = 'rework';
    await emit({ type: 'stage_transition', stage: 'rework', reworkAttempt: reworkAttempts });

    draft = await processTask({
      ...baseTask,
      context: `${baseTask.context ?? ''}\n\nReviewer notes to address: ${review.notes}`.trim(),
    });
    await emit({
      type: 'agent_output',
      stage: 'rework',
      reworkAttempt: reworkAttempts,
      payload: { content: draft.content } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
    });

    stage = 'review';
    await emit({ type: 'stage_transition', stage: 'review' });
    review = await reviewTask(draft);
    await emit({
      type: 'agent_output',
      stage: 'review',
      payload: { content: review.notes || (review.approved ? 'approved' : '') } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
    });
  }

  const reviewerOverruled = !review.approved;

  // ─── sign-off ──────────────────────────────────────────────────────────
  stage = 'sign-off';
  await emit({ type: 'stage_transition', stage: 'sign-off' });
  await productSignOff(draft, review);

  // ─── done + final answer ───────────────────────────────────────────────
  stage = 'done';
  await emit({ type: 'stage_transition', stage: 'done' });
  await emit({
    type: 'agent_output',
    stage: 'done',
    payload: {
      content: draft.content,
      reviewerOverruled: reviewerOverruled || undefined,
    } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
  });

  return {
    taskId: turnId,
    content: draft.content,
    review,
    reworkAttempts,
    reviewerOverruled,
  };
}

// Re-export workflowInfo for tests that want to assert on the active workflow.
export { workflowInfo };
