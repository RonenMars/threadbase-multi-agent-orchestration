// test/workflows/project-path.test.ts
//
// The session's project path reaches each agent activity, picks the 30-minute
// tier for agent-sdk roles, survives continue-as-new, and a role that had to
// run without tools says so once.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { defaultPayloadConverter } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { nanoid } from 'nanoid';
import type { ProgressEvent, UserInputSignal } from '@threadbase-sh/agent-types';
import type { AgentCall } from '../../src/shared/types';
import { approvingGates } from '../threadbase/approve-gates';

const workflowsPath = path.resolve(__dirname, '../../src/workflows/index.ts');
const { EventType } = temporal.api.enums.v1;
type History = temporal.api.history.v1.IHistory;

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); });
afterAll(async () => { await env?.teardown(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startSession(opts: { projectPath?: string; note?: string; rejectFirst?: boolean } = {}) {
  const emitted: ProgressEvent[] = [];
  const calls: { activity: string; call?: AgentCall }[] = [];
  let runtimeLookups = 0;
  const taskQueue = `tq-${nanoid(6)}`;
  const sessionId = `sess-${nanoid(6)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: {
      roleRuntimes: async () => { runtimeLookups++; return { worker: 'agent-sdk', reviewer: 'text' }; },
      processTask: async (task: { id: string }, call?: AgentCall) => {
        calls.push({ activity: 'processTask', call });
        return { taskId: task.id, content: 'draft', ...(opts.note ? { note: opts.note } : {}) };
      },
      reviewTask: async (draft: { taskId: string }, call?: AgentCall) => {
        calls.push({ activity: 'reviewTask', call });
        const approved = !opts.rejectFirst || calls.filter((c) => c.activity === 'reviewTask').length > 1;
        return { taskId: draft.taskId, approved, notes: approved ? '' : 'again' };
      },
      productSignOff: async () => true,
      sendProgressEvent: approvingGates(env.client, async (ev: ProgressEvent) => { emitted.push(ev); }),
    },
  });
  const handle = await env.client.workflow.start('orchestratorWorkflow', {
    taskQueue,
    workflowId: `session-${sessionId}`,
    args: opts.projectPath ? [sessionId, { projectPath: opts.projectPath }] : [sessionId],
  });
  const signal = (turnId: string) =>
    handle.signal('userInput', { turnId, prompt: 'p', conversationHistory: [] } satisfies UserInputSignal);
  const done = (turnId: string) => emitted.some((e) => e.turnId === turnId && e.stage === 'done');
  return { handle, worker, signal, done, emitted, calls, lookups: () => runtimeLookups };
}

/** startToCloseTimeout, in seconds, of each activity the turn scheduled. */
async function activityTimeouts(turnId: string): Promise<Record<string, number>> {
  const history = await env.client.workflow.getHandle(`turn-${turnId}`).fetchHistory();
  const out: Record<string, number> = {};
  for (const e of history.events!) {
    if (e.eventType !== EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) continue;
    const a = e.activityTaskScheduledEventAttributes!;
    out[a.activityType!.name!] = Number(a.startToCloseTimeout!.seconds);
  }
  return out;
}

describe('orchestratorWorkflow with a project path', () => {
  it('passes the path to each role and gives the agent-sdk role the 30-minute tier', async () => {
    const s = await startSession({ projectPath: '/repo' });
    await s.worker.runUntil(async () => {
      await s.signal('t1');
      while (!s.done('t1')) await sleep(50);
      await s.handle.cancel();
    });

    expect(s.calls).toEqual([
      { activity: 'processTask', call: { role: 'worker', cwd: '/repo' } },
      { activity: 'reviewTask', call: { role: 'reviewer', cwd: '/repo' } },
    ]);
    expect(s.lookups()).toBe(1);
    expect(await activityTimeouts('t1')).toMatchObject({ processTask: 1800, reviewTask: 300 });
    const child = await env.client.workflow.getHandle('turn-t1').fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, child, 'turn-t1');
  });

  it('without a path, never looks up runtimes, keeps the 5-minute tier and shows a note once', async () => {
    const note = 'The worker has no project directory for this session, so it ran without tools.';
    const s = await startSession({ note, rejectFirst: true });
    await s.worker.runUntil(async () => {
      await s.signal('t2');
      while (!s.done('t2')) await sleep(50);
      await s.handle.cancel();
    });

    // One rework: the worker runs twice, but the note shows once.
    expect(s.calls.map((c) => c.call)).toEqual([{ role: 'worker' }, { role: 'reviewer' }, { role: 'worker' }, { role: 'reviewer' }]);
    expect(s.lookups()).toBe(0);
    expect(await activityTimeouts('t2')).toMatchObject({ processTask: 300, reviewTask: 300 });
    const notes = s.emitted.filter((e) => e.type === 'agent_output' && (e.payload as { content?: string })?.content === note);
    expect(notes).toHaveLength(1);
    expect(notes[0].stage).toBe('processing');
  });

  it('carries the path across continue-as-new', async () => {
    const s = await startSession({ projectPath: '/repo' });
    const turnIds = Array.from({ length: 21 }, (_, i) => `cp-${nanoid(4)}-${i}`);
    await s.worker.runUntil(async () => {
      for (const t of turnIds) await s.signal(t);
      while (!s.done(turnIds.at(-1)!)) await sleep(50);
      await s.handle.cancel();
    });

    const first: History = await env.client.workflow.getHandle(s.handle.workflowId, s.handle.firstExecutionRunId).fetchHistory();
    const cont = first.events!.at(-1)!.workflowExecutionContinuedAsNewEventAttributes!;
    const [, carried] = cont.input!.payloads!.map((p) => defaultPayloadConverter.fromPayload(p));
    expect(carried).toMatchObject({ projectPath: '/repo' });
    // The 21st turn ran in the second run and still got the path.
    expect(s.calls.filter((c) => c.activity === 'processTask').at(-1)!.call).toEqual({ role: 'worker', cwd: '/repo' });
  }, 120_000);
});
