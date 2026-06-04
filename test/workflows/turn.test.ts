// test/workflows/turn.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { nanoid } from 'nanoid';
import path from 'node:path';
import type { ProgressEvent } from '@threadbase/agent-types';

import type { TurnInput } from '../../src/shared/types';
import type { Draft, Review } from '../../src/shared/types';

let env: TestWorkflowEnvironment;
let workflowsPath: string;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  workflowsPath = path.resolve(__dirname, '../../src/workflows/index.ts');
});

afterAll(async () => {
  await env?.teardown();
});

interface ScenarioOptions {
  reviewerApprovesAfter: number; // 0 = approves on first review; 1 = after rework #1; 2 = after rework #2; 3 = never (rework cap)
}

function makeStubActivities(emitted: ProgressEvent[], opts: ScenarioOptions) {
  let reviewCalls = 0;

  return {
    processTask: async (task: { id: string; prompt: string; context?: string }): Promise<Draft> => ({
      taskId: task.id,
      content: `draft for ${task.id} (ctx=${task.context ?? ''})`,
    }),
    reviewTask: async (draft: Draft): Promise<Review> => {
      const callIndex = reviewCalls;
      reviewCalls += 1;
      const approved = callIndex >= opts.reviewerApprovesAfter;
      return { taskId: draft.taskId, approved, notes: approved ? '' : 'please revise' };
    },
    productSignOff: async (_d: Draft, _r: Review) => true,
    sendProgressEvent: async (ev: ProgressEvent) => {
      emitted.push(ev);
    },
  };
}

async function runTurnWorkflow(emitted: ProgressEvent[], opts: ScenarioOptions) {
  const { turnWorkflow } = await import('../../src/workflows/turn');
  const taskQueue = `tq-${nanoid(6)}`;

  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: makeStubActivities(emitted, opts),
  });

  const input: TurnInput = {
    sessionId: 'sess_test',
    turnId: `turn_${nanoid(6)}`,
    prompt: 'do the thing',
    conversationHistory: [],
  };

  const handle = await env.client.workflow.start(turnWorkflow, {
    taskQueue,
    workflowId: `turn-${input.turnId}`,
    args: [input],
  });

  await worker.runUntil(handle.result());
  return await handle.result();
}

describe('turnWorkflow', () => {
  it('emits stage transitions: processing → review → sign-off → done (happy path)', async () => {
    const emitted: ProgressEvent[] = [];
    const result = await runTurnWorkflow(emitted, { reviewerApprovesAfter: 0 });

    const stages = emitted
      .filter((e) => e.type === 'stage_transition')
      .map((e) => e.stage);
    expect(stages).toEqual(['processing', 'review', 'sign-off', 'done']);
    expect(result.review.approved).toBe(true);
    expect(result.reworkAttempts).toBe(0);
  });

  it('loops up to 2 reworks then signs off when reviewer approves rework #1', async () => {
    const emitted: ProgressEvent[] = [];
    const result = await runTurnWorkflow(emitted, { reviewerApprovesAfter: 1 });

    const stages = emitted
      .filter((e) => e.type === 'stage_transition')
      .map((e) => e.stage);
    expect(stages).toEqual(['processing', 'review', 'rework', 'review', 'sign-off', 'done']);
    expect(result.reworkAttempts).toBe(1);
  });

  it('caps rework at 2 and emits reviewerOverruled on the final agent_output', async () => {
    const emitted: ProgressEvent[] = [];
    const result = await runTurnWorkflow(emitted, { reviewerApprovesAfter: 3 });

    const stages = emitted
      .filter((e) => e.type === 'stage_transition')
      .map((e) => e.stage);
    expect(stages).toEqual([
      'processing', 'review',
      'rework', 'review',
      'rework', 'review',
      'sign-off', 'done',
    ]);
    expect(result.reworkAttempts).toBe(2);

    const finalOutput = [...emitted].reverse().find(
      (e) => e.type === 'agent_output' && (e.payload as { reviewerOverruled?: boolean })?.reviewerOverruled,
    );
    expect(finalOutput).toBeDefined();
    expect((finalOutput!.payload as { content: string }).content).toContain('draft for');
  });

  it('attaches reworkAttempt to rework stage_transitions', async () => {
    const emitted: ProgressEvent[] = [];
    await runTurnWorkflow(emitted, { reviewerApprovesAfter: 2 });

    const reworks = emitted.filter((e) => e.stage === 'rework' && e.type === 'stage_transition');
    expect(reworks.map((r) => r.reworkAttempt)).toEqual([1, 2]);
  });

  it('assigns monotonic seq values per turn starting at 0', async () => {
    const emitted: ProgressEvent[] = [];
    await runTurnWorkflow(emitted, { reviewerApprovesAfter: 0 });
    const seqs = emitted.map((e) => e.seq);
    // strictly increasing
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(0);
  });

  it('uses the turnInput.turnId on every emitted event', async () => {
    const emitted: ProgressEvent[] = [];
    const result = await runTurnWorkflow(emitted, { reviewerApprovesAfter: 0 });
    // result.taskId is the turn id (we reuse the field name from Plan-1 spec).
    expect(emitted.every((e) => e.turnId === result.taskId)).toBe(true);
  });
});
