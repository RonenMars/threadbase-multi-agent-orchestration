// test/threadbase/sign-off-gate.test.ts
//
// The Threadbase sign-off is a real gate: the phone answers Approve, Request
// changes or Stop through the `gateAnswer` signal, sent to the turn's own
// child workflow. Every outcome still ends the turn at `done`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { nanoid } from 'nanoid';
import path from 'node:path';
import type { GateAnswerSignal, ProgressEvent } from '@threadbase-sh/agent-types';

import type { Draft, Review, Task } from '../../src/shared/types';

let env: TestWorkflowEnvironment;
const workflowsPath = path.resolve(__dirname, '../../src/workflows/index.ts');

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await env?.teardown();
});

type Ev = Omit<ProgressEvent, 'eventId'>;

/** Runs one turn; `answer` is called for each gate_open and returns the signal to send, or undefined to let it time out. */
async function run(answer: (gateId: string, n: number) => GateAnswerSignal | undefined) {
  const events: Ev[] = [];
  const tasks: Task[] = [];
  let drafts = 0;
  const taskQueue = `tq-${nanoid(6)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: {
      processTask: async (task: Task): Promise<Draft> => {
        tasks.push(task);
        return { taskId: task.id, content: `draft ${drafts++}` };
      },
      reviewTask: async (draft: Draft): Promise<Review> => ({ taskId: draft.taskId, approved: true, notes: '' }),
      productSignOff: async () => {
        throw new Error('the real gate must not call the sign-off stub');
      },
      roleRuntimes: async () => ({}),
      sendProgressEvent: async ({ eventId: _e, ...ev }: ProgressEvent) => {
        events.push(ev);
      },
    },
  });
  return worker.runUntil(async () => {
    const handle = await env.client.workflow.start('pipelineWorkflow', {
      taskQueue,
      workflowId: `turn-${nanoid(6)}`,
      args: [{ sessionId: 'sess-gate', turnId: 'turn-gate', prompt: 'do it', conversationHistory: [] }],
    });
    // Answer each gate as it opens; then let the clock skip to the end.
    for (let answered = 0; ; ) {
      const opens = events.filter((e) => e.type === 'gate_open');
      if (opens.length > answered) {
        const gateId = (opens[answered].payload as { gateId: string }).gateId;
        const sig = answer(gateId, answered);
        answered += 1;
        if (!sig) break;
        await handle.signal('gateAnswer', sig);
        if (sig.gateId !== gateId) break; // a stale answer closes nothing; let the gate time out
        continue;
      }
      if (events.some((e) => e.stage === 'done')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const result = await handle.result();
    return { events, tasks, result };
  });
}

const doneContent = (events: Ev[]) =>
  (events.find((e) => e.type === 'agent_output' && e.stage === 'done')!.payload as { content: string }).content;

describe('sign-off gate', () => {
  it('opens a gate card at sign-off and releases the answer on Approve', async () => {
    const { events, result } = await run((gateId) => ({ gateId, optionIndex: 0 }));
    const open = events.find((e) => e.type === 'gate_open')!;
    expect(open.stage).toBe('sign-off');
    expect(open.payload).toEqual({
      gateId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      prompt: 'Release this answer?',
      options: ['Approve', 'Request changes', 'Stop'],
    });
    expect(events.find((e) => e.type === 'gate_closed')).toMatchObject({
      stage: 'sign-off',
      payload: { gateId: (open.payload as { gateId: string }).gateId, optionIndex: 0, timedOut: false },
    });
    expect(doneContent(events)).toBe('draft 0');
    expect(result.content).toBe('draft 0');
    expect(events.at(-1)).toMatchObject({ type: 'agent_output', stage: 'done' });
  });

  it('reworks on Request changes, then asks again under a new gate id', async () => {
    const ids: string[] = [];
    const { events, tasks } = await run((gateId, n) => {
      ids.push(gateId);
      return { gateId, optionIndex: n === 0 ? 1 : 0 };
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(tasks).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: 'stage_transition', stage: 'rework', reworkAttempt: 1 }));
    expect(doneContent(events)).toBe('draft 1');
  });

  it('ends the turn at done without releasing the answer on Stop', async () => {
    const { events, result } = await run((gateId) => ({ gateId, optionIndex: 2 }));
    expect(events.find((e) => e.type === 'gate_closed')!.payload).toMatchObject({ optionIndex: 2, timedOut: false });
    expect(doneContent(events)).toBe('Stopped at sign-off. The answer was not released.');
    expect(result.content).toBe('Stopped at sign-off. The answer was not released.');
  });

  it('approves after 12 hours with no answer', async () => {
    const { events } = await run(() => undefined);
    const closed = events.find((e) => e.type === 'gate_closed')!;
    expect(closed.payload).toMatchObject({ optionIndex: 0, timedOut: true });
    expect(closed.timestamp - events.find((e) => e.type === 'gate_open')!.timestamp).toBe(12 * 3600);
    expect(doneContent(events)).toBe('draft 0');
  });

  it('drops an answer for a stale gate id', async () => {
    let first = true;
    const { events } = await run((gateId) => {
      if (first) {
        first = false;
        return { gateId: 'stale-' + gateId, optionIndex: 2 };
      }
      return undefined;
    });
    // The stale Stop was dropped; the gate timed out to Approve.
    expect(events.find((e) => e.type === 'gate_closed')!.payload).toMatchObject({ timedOut: true, optionIndex: 0 });
    expect(doneContent(events)).toBe('draft 0');
  });
});
