// src/threadbase/pipeline.ts
//
// ONE-SHOT child workflow per user turn: the Threadbase pipeline (worker →
// reviewer, up to 2 reworks → sign-off) run by the engine. It replaces
// `turnWorkflow` for new turns and emits the same events in the same order.
//
// Determinism rules:
// - `eventId` is generated via workflow.uuid4() — replay-safe (spec §7.6).
// - `timestamp` uses the workflow's deterministic Date.now().
// - `seq` is incremented from a per-turn counter — no global mutable state.

import { proxyActivities, setHandler, uuid4, log } from '@temporalio/workflow';
import type { ProgressEvent } from '@threadbase-sh/agent-types';

import { runPipeline } from '../engine/run';
import type { PipelineSpec } from '../engine/pipeline';
import type * as agentActivities from '../activities/agents';
import type { Draft, Review, Task, TurnInput } from '../shared/types';
import type { TurnResult } from '../workflows/turn';
import { createSeq } from '../workflows/eventSeq';
import type * as progressActivities from './progress';
import { stageQuery } from './signals';
import { toProgress, type ProgressPartial } from './stages';

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

export const threadbasePipeline: PipelineSpec = {
  phases: [
    { kind: 'agent', role: 'worker' },
    { kind: 'review', role: 'reviewer', maxRework: 2 },
    { kind: 'gate', name: 'sign-off' },
  ],
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function pipelineWorkflow(input: TurnInput): Promise<TurnResult> {
  const { sessionId, turnId, prompt, conversationHistory } = input;
  let stage = 'processing';
  setHandler(stageQuery, () => stage);

  log.info('turn started', {
    sessionId,
    turnId,
    historyTurns: conversationHistory.length,
    promptLength: prompt.length,
  });

  const seq = createSeq();

  async function send(partial: ProgressPartial): Promise<void> {
    const ev: ProgressEvent = {
      ...partial,
      sessionId,
      turnId,
      eventId: uuid4(),
      seq: seq(),
      timestamp: nowSeconds(),
    };
    if (partial.type === 'stage_transition') {
      stage = partial.stage!;
      log.info('stage transition', {
        sessionId,
        turnId,
        stage: partial.stage,
        reworkAttempt: partial.reworkAttempt,
        seq: ev.seq,
      });
    } else {
      log.debug('progress event emitted', {
        sessionId,
        turnId,
        type: partial.type,
        stage: partial.stage,
        seq: ev.seq,
      });
    }
    await sendProgressEvent(ev);
  }

  // History is stitched here (deterministic) rather than inside an activity,
  // so the same Task arrives across activity retries.
  const historyText = conversationHistory
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n');

  const baseTask: Task = {
    id: turnId,
    sessionId,
    prompt,
    context: historyText || undefined,
  };

  let draft: Draft | undefined;
  let review: Review | undefined;

  const result = await runPipeline(threadbasePipeline, {
    async agent(_phase, rework) {
      draft = await processTask(rework
        ? {
          ...baseTask,
          context: `${baseTask.context ?? ''}\n\nReviewer notes to address: ${rework.notes}`.trim(),
        }
        : baseTask);
      return draft.content;
    },
    async review() {
      review = await reviewTask(draft!);
      return review;
    },
    async gate() {
      await productSignOff(draft!, review!);
    },
    async emit(event) {
      for (const partial of toProgress(event)) await send(partial);
    },
  });

  log.info('turn completed', {
    sessionId,
    turnId,
    reworkAttempts: result.reworkAttempts,
    reviewerOverruled: result.overruled,
    contentLength: result.content.length,
  });

  return {
    taskId: turnId,
    content: result.content,
    review: review!,
    reworkAttempts: result.reworkAttempts,
    reviewerOverruled: result.overruled,
  };
}
