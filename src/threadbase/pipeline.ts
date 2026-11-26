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

import { condition, proxyActivities, proxyLocalActivities, setHandler, uuid4, log } from '@temporalio/workflow';
import type { Duration } from '@temporalio/common';
import type { ProgressEvent, Stage } from '@threadbase-sh/agent-types';

import { runPipeline } from '../engine/run';
import type { PipelineSpec } from '../engine/pipeline';
import type * as agentActivities from '../activities/agents';
import type { AgentCall, Draft, Review, Task, TurnInput } from '../shared/types';
import type { TurnResult } from '../workflows/turn';
import { createSeq } from '../workflows/eventSeq';
import type * as progressActivities from './progress';
import { stageQuery } from './signals';
import { toProgress, type ProgressPartial } from './stages';

// Timeout tiers: a text agent is one model call; an agent-sdk session works
// in the repo for many turns. Both heartbeat, so a dead worker shows in 60 s.
const text = proxyActivities<typeof agentActivities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});
const { productSignOff } = text;

const sdk = proxyActivities<typeof agentActivities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '60 seconds',
  retry: { maximumAttempts: 2, initialInterval: '10 seconds' },
});

const { roleRuntimes } = proxyLocalActivities<typeof agentActivities>({
  startToCloseTimeout: '10 seconds',
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
  const { sessionId, turnId, prompt, conversationHistory, projectPath } = input;
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

  // Without a project path every role runs as text, so the turn records the
  // same commands it always did.
  const runtimeOf = projectPath ? await roleRuntimes() : {};
  const call = (role: string): AgentCall => ({ role, ...(projectPath ? { cwd: projectPath } : {}) });
  const tier = (role: string) => (runtimeOf[role] === 'agent-sdk' ? sdk : text);
  const noted = new Set<string>();
  async function note(role: string, out: { note?: string }): Promise<void> {
    if (!out.note || noted.has(role)) return;
    noted.add(role);
    await send({ type: 'agent_output', stage: stage as Stage, payload: { content: out.note } });
  }

  const result = await runPipeline(threadbasePipeline, {
    async agent(phase, rework) {
      const role = phase.kind === 'agent' ? phase.role : 'worker';
      draft = await tier(role).processTask(rework
        ? {
          ...baseTask,
          context: `${baseTask.context ?? ''}\n\nReviewer notes to address: ${rework.notes}`.trim(),
        }
        : baseTask, call(role));
      await note(role, draft);
      return draft.content;
    },
    async review(phase) {
      const role = phase.kind === 'review' ? phase.role : 'reviewer';
      review = await tier(role).reviewTask(draft!, call(role));
      await note(role, review);
      return review;
    },
    async gate() {
      await productSignOff(draft!, review!);
    },
    newId: () => uuid4(),
    wait: (ready, timeout) => condition(ready, timeout as Duration),
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
