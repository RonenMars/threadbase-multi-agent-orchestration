// test/workflows/orchestrator.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { nanoid } from 'nanoid';
import path from 'node:path';
import type { ProgressEvent, UserInputSignal } from '@threadbase/agent-types';

let env: TestWorkflowEnvironment;
let workflowsPath: string;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  workflowsPath = path.resolve(__dirname, '../../src/workflows/index.ts');
});

afterAll(async () => {
  await env?.teardown();
});

function makeActivities(emitted: ProgressEvent[], opts: { failTurnIds?: Set<string> } = {}) {
  return {
    processTask: async (task: { id: string }) => ({ taskId: task.id, content: `draft for ${task.id}` }),
    reviewTask: async (draft: { taskId: string }) => {
      if (opts.failTurnIds?.has(draft.taskId)) {
        throw new Error('reviewer-blew-up');
      }
      return { taskId: draft.taskId, approved: true, notes: '' };
    },
    productSignOff: async () => true,
    sendProgressEvent: async (ev: ProgressEvent) => { emitted.push(ev); },
  };
}

async function startOrchestrator(emitted: ProgressEvent[], opts: { failTurnIds?: Set<string> } = {}) {
  const { orchestratorWorkflow } = await import('../../src/workflows/orchestrator');
  const { userInputSignal } = await import('../../src/workflows/signals');
  const taskQueue = `tq-${nanoid(6)}`;
  const sessionId = `sess-${nanoid(6)}`;

  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: makeActivities(emitted, opts),
  });

  const handle = await env.client.workflow.start(orchestratorWorkflow, {
    taskQueue,
    workflowId: `session-${sessionId}`,
    args: [sessionId],
  });

  return { handle, worker, taskQueue, sessionId, userInputSignal };
}

describe('orchestratorWorkflow', () => {
  it('processes a single userInput signal end-to-end', async () => {
    const emitted: ProgressEvent[] = [];
    const { handle, worker, userInputSignal, sessionId } = await startOrchestrator(emitted);

    const runUntilDone = worker.runUntil(async () => {
      await handle.signal(userInputSignal, {
        turnId: 'turn-1',
        prompt: 'hi',
        conversationHistory: [],
      });
      // wait for the turn's `done` stage transition to flow through
      while (!emitted.some((e) => e.turnId === 'turn-1' && e.stage === 'done')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await handle.cancel();
    });

    await runUntilDone;

    expect(emitted.some((e) => e.sessionId === sessionId && e.turnId === 'turn-1' && e.stage === 'done')).toBe(true);
  });

  it('serializes two back-to-back signals — second turn does not start until first completes', async () => {
    const emitted: ProgressEvent[] = [];
    const { handle, worker, userInputSignal } = await startOrchestrator(emitted);

    const runUntilDone = worker.runUntil(async () => {
      await handle.signal(userInputSignal, { turnId: 'turn-A', prompt: 'A', conversationHistory: [] });
      await handle.signal(userInputSignal, { turnId: 'turn-B', prompt: 'B', conversationHistory: [] });

      while (!(
        emitted.some((e) => e.turnId === 'turn-A' && e.stage === 'done') &&
        emitted.some((e) => e.turnId === 'turn-B' && e.stage === 'done')
      )) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await handle.cancel();
    });

    await runUntilDone;

    // The first `processing` for turn-A must precede the first `processing` for turn-B.
    const aProcessingIdx = emitted.findIndex((e) => e.turnId === 'turn-A' && e.stage === 'processing');
    const bProcessingIdx = emitted.findIndex((e) => e.turnId === 'turn-B' && e.stage === 'processing');
    expect(aProcessingIdx).toBeGreaterThanOrEqual(0);
    expect(bProcessingIdx).toBeGreaterThan(aProcessingIdx);

    // And turn-B must emit a `queued` stage transition while turn-A is running.
    const queuedForB = emitted.find((e) => e.turnId === 'turn-B' && e.stage === 'queued');
    expect(queuedForB).toBeDefined();
  });

  it('catches a failed child workflow and continues to accept new signals', async () => {
    const emitted: ProgressEvent[] = [];
    const { handle, worker, userInputSignal } = await startOrchestrator(emitted, {
      failTurnIds: new Set(['turn-bad']),
    });

    const runUntilDone = worker.runUntil(async () => {
      // turn-bad will throw inside reviewTask after exhausting Temporal retries
      await handle.signal(userInputSignal, { turnId: 'turn-bad', prompt: 'bad', conversationHistory: [] });
      // wait for terminal_failure
      while (!emitted.some((e) => e.turnId === 'turn-bad' && e.type === 'terminal_failure')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // now send a good turn and confirm it completes
      await handle.signal(userInputSignal, { turnId: 'turn-good', prompt: 'good', conversationHistory: [] });
      while (!emitted.some((e) => e.turnId === 'turn-good' && e.stage === 'done')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await handle.cancel();
    });

    await runUntilDone;

    expect(emitted.some((e) => e.turnId === 'turn-bad' && e.type === 'terminal_failure')).toBe(true);
    expect(emitted.some((e) => e.turnId === 'turn-good' && e.stage === 'done')).toBe(true);
  });
});
