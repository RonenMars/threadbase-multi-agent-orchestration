// test/workflows/continue-as-new.test.ts
//
// A long session continues as new between turns, carries the inputs still
// queued, and sends no second `queued` event for them. A session recorded
// before continue-as-new existed keeps replaying past the turn limit.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { defaultPayloadConverter } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { nanoid } from 'nanoid';
import type { ProgressEvent, UserInputSignal } from '@threadbase-sh/agent-types';

const workflowsPath = path.resolve(__dirname, '../../src/workflows/index.ts');
const { EventType } = temporal.api.enums.v1;
type History = temporal.api.history.v1.IHistory;

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await env?.teardown();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startSession(emitted: ProgressEvent[], opts: { slowQueuedTurnIds?: Set<string> } = {}) {
  const taskQueue = `tq-${nanoid(6)}`;
  const sessionId = `sess-${nanoid(6)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: {
      processTask: async (task: { id: string }) => ({ taskId: task.id, content: 'draft' }),
      reviewTask: async (draft: { taskId: string }) => ({ taskId: draft.taskId, approved: true, notes: '' }),
      productSignOff: async () => true,
      sendProgressEvent: async (ev: ProgressEvent) => {
        if (ev.stage === 'queued' && opts.slowQueuedTurnIds?.has(ev.turnId)) await sleep(3000);
        emitted.push(ev);
      },
    },
  });
  // The streamer's start shape: workflow type by name, args [sessionId].
  const handle = await env.client.workflow.start('orchestratorWorkflow', {
    taskQueue,
    workflowId: `session-${sessionId}`,
    args: [sessionId],
  });
  const signal = (turnId: string) =>
    handle.signal('userInput', { turnId, prompt: 'p', conversationHistory: [] } satisfies UserInputSignal);
  const done = (turnId: string) => emitted.some((e) => e.turnId === turnId && e.stage === 'done');
  return { handle, worker, signal, done };
}

/** Every run of the session, first to last, with its history. */
async function runsOf(workflowId: string, firstRunId: string): Promise<History[]> {
  const runs: History[] = [];
  let runId: string | undefined = firstRunId;
  while (runId) {
    const history: History = await env.client.workflow.getHandle(workflowId, runId).fetchHistory();
    runs.push(history);
    const last: temporal.api.history.v1.IHistoryEvent = history.events!.at(-1)!;
    runId = last.eventType === EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW
      ? last.workflowExecutionContinuedAsNewEventAttributes!.newExecutionRunId!
      : undefined;
  }
  return runs;
}

const childStarts = (h: History) =>
  h.events!.filter((e) => e.eventType === EventType.EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED).length;

/** The queue a run handed to the next one. */
function carriedQueue(h: History): UserInputSignal[] {
  const [started] = h.events!;
  const [sessionId, carry] = h.events!.at(-1)!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads!
    .map((p) => defaultPayloadConverter.fromPayload(p));
  // The next run keeps the session id as its first argument.
  expect(sessionId).toBe(defaultPayloadConverter.fromPayload(started.workflowExecutionStartedEventAttributes!.input!.payloads![0]));
  return (carry as { queue: UserInputSignal[] }).queue;
}

function expectStagesInOrder(emitted: ProgressEvent[], turnIds: string[]) {
  const firstIndex = (turnId: string, stage: string) =>
    emitted.findIndex((e) => e.turnId === turnId && e.stage === stage);
  const doneOrder = emitted.filter((e) => e.type === 'stage_transition' && e.stage === 'done').map((e) => e.turnId);
  expect(doneOrder).toEqual(turnIds);
  for (const turnId of turnIds) {
    const queued = emitted.filter((e) => e.turnId === turnId && e.stage === 'queued');
    expect(queued.length, `queued events for ${turnId}`).toBeLessThanOrEqual(1);
    if (queued.length) expect(firstIndex(turnId, 'queued')).toBeLessThan(firstIndex(turnId, 'processing'));
  }
}

describe('orchestratorWorkflow continue-as-new', () => {
  it('runs 30 queued turns across two runs without dropping or re-announcing any', async () => {
    const emitted: ProgressEvent[] = [];
    const { handle, worker, signal, done } = await startSession(emitted);
    const turnIds = Array.from({ length: 30 }, (_, i) => `turn-${i + 1}`);

    await worker.runUntil(async () => {
      for (const turnId of turnIds) await signal(turnId);
      while (!done('turn-30')) await sleep(50);
      expect(await handle.query('queueDepth')).toBe(0);
      await handle.cancel();
    });

    expectStagesInOrder(emitted, turnIds);
    // Every turn but the first waited behind another, so each got one `queued`.
    for (const turnId of turnIds.slice(1)) {
      expect(emitted.filter((e) => e.turnId === turnId && e.stage === 'queued')).toHaveLength(1);
    }

    const runs = await runsOf(handle.workflowId, handle.firstExecutionRunId);
    expect(runs.map(childStarts)).toEqual([20, 10]);
    expect(carriedQueue(runs[0]).map((s) => s.turnId)).toEqual(turnIds.slice(20));
    for (const run of runs) await Worker.runReplayHistory({ workflowsPath }, run, handle.workflowId);
  }, 120_000);

  it('continues as new before the turn limit once the history passes its limit', async () => {
    const emitted: ProgressEvent[] = [];
    const { handle, worker, signal } = await startSession(emitted);
    const turnIds = Array.from({ length: 120 }, (_, i) => `flood-${i + 1}`);
    let runs: History[] = [];

    await worker.runUntil(async () => {
      for (const turnId of turnIds) await signal(turnId);
      while ((runs = await runsOf(handle.workflowId, handle.firstExecutionRunId)).length < 2) await sleep(100);
      await handle.cancel();
    });

    const turnsInFirstRun = childStarts(runs[0]);
    expect(turnsInFirstRun).toBeLessThan(20);
    expect(carriedQueue(runs[0]).map((s) => s.turnId)).toEqual(turnIds.slice(turnsInFirstRun));
  }, 120_000);

  it('waits for an in-flight userInput handler before continuing as new', async () => {
    const emitted: ProgressEvent[] = [];
    // turn-21's `queued` event takes 3s, longer than turn-20 takes to run.
    const { handle, worker, signal, done } = await startSession(emitted, { slowQueuedTurnIds: new Set(['turn-21']) });
    const turnIds = Array.from({ length: 21 }, (_, i) => `turn-${i + 1}`);

    await worker.runUntil(async () => {
      for (const turnId of turnIds.slice(0, 19)) {
        await signal(turnId);
        while (!done(turnId)) await sleep(20);
      }
      await signal('turn-20');
      await signal('turn-21');
      while (!done('turn-21')) await sleep(50);
      await handle.cancel();
    });

    expectStagesInOrder(emitted, turnIds);
    const runs = await runsOf(handle.workflowId, handle.firstExecutionRunId);
    expect(runs.map(childStarts)).toEqual([20, 1]);
  }, 120_000);
});

describe('replay of a session recorded before continue-as-new', () => {
  it('replays 25 turns, past the turn limit, without continuing as new', async () => {
    const json = readFileSync(path.resolve(__dirname, '../fixtures/orchestrator-long-history.json'), 'utf8');
    const history = temporal.api.history.v1.History.fromObject(JSON.parse(json));
    expect(childStarts(history)).toBe(25);
    await Worker.runReplayHistory({ workflowsPath }, history, 'session-sess-record-long');
  });
});
