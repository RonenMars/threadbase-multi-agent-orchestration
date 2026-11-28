// test/threadbase/rework-gate.test.ts
//
// The rework-cap gate on the wire, and the rule that every turn ends in `done`
// or `terminal_failure`, with an activity throwing inside each phase.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { nanoid } from 'nanoid';
import path from 'node:path';
import type { ProgressEvent } from '@threadbase-sh/agent-types';

import type { AgentCall, Draft, Review, Task } from '../../src/shared/types';

let env: TestWorkflowEnvironment;
const workflowsPath = path.resolve(__dirname, '../../src/workflows/index.ts');

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await env?.teardown();
});

interface Opts {
  /** One per gate, by option label; 'timeout' leaves it unanswered. */
  answers: string[];
  /** The first review call (0-based) that approves. */
  approvesAt?: number;
  escalation?: boolean;
  throwIn?: 'agent' | 'review' | 'rework' | 'escalated' | 'escalation lookup';
}

/** Runs one turn through the session workflow until it reaches an end event. */
async function run({ answers, approvesAt = Infinity, escalation = true, throwIn }: Opts) {
  const events: ProgressEvent[] = [];
  const calls: Array<{ task: Task; call: AgentCall }> = [];
  let reviews = 0;
  const boom = () => ApplicationFailure.nonRetryable('boom');
  const taskQueue = `tq-${nanoid(6)}`;
  const turnId = `turn-${nanoid(6)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: {
      processTask: async (task: Task, call: AgentCall): Promise<Draft> => {
        calls.push({ task, call });
        if (throwIn === 'agent') throw boom();
        if (throwIn === 'rework' && calls.length === 2) throw boom();
        if (throwIn === 'escalated' && call.escalate) throw boom();
        return { taskId: task.id, content: `draft ${calls.length - 1}` };
      },
      reviewTask: async (draft: Draft): Promise<Review> => {
        if (throwIn === 'review') throw boom();
        const n = reviews++;
        return { taskId: draft.taskId, approved: n >= approvesAt, notes: `notes ${n}` };
      },
      productSignOff: async () => true,
      roleRuntimes: async () => ({}),
      escalationAvailable: async () => {
        // A plain error, so only the retry limit ends it.
        if (throwIn === 'escalation lookup') throw new Error('bad roles file');
        return escalation;
      },
      sendProgressEvent: async (ev: ProgressEvent) => {
        events.push(ev);
      },
    },
  });
  const ended = () =>
    events.some((e) => e.type === 'terminal_failure' || (e.type === 'agent_output' && e.stage === 'done'));
  await worker.runUntil(async () => {
    const session = await env.client.workflow.start('orchestratorWorkflow', {
      taskQueue,
      workflowId: `session-${nanoid(6)}`,
      args: ['sess-cap'],
    });
    await session.signal('userInput', { turnId, prompt: 'do it', conversationHistory: [] });
    let timingOut = false;
    for (let handled = 0; !ended() && !timingOut; ) {
      const opens = events.filter((e) => e.type === 'gate_open');
      if (opens.length > handled) {
        const { gateId, options } = opens[handled].payload as { gateId: string; options: string[] };
        const label = answers[handled++];
        if (label === undefined) throw new Error(`unscripted gate: ${options.join(', ')}`);
        if (label === 'timeout') {
          timingOut = true;
          continue;
        }
        expect(options).toContain(label);
        await env.client.workflow
          .getHandle(`turn-${turnId}`)
          .signal('gateAnswer', { gateId, optionIndex: options.indexOf(label) });
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    // Waiting on the child's result lets the test clock skip to the gate timeout.
    if (timingOut) await env.client.workflow.getHandle(`turn-${turnId}`).result();
    while (!ended()) await new Promise((r) => setTimeout(r, 20));
    await session.cancel();
    await session.result();
  });
  const opens = events.filter((e) => e.type === 'gate_open');
  const done = events.find((e) => e.type === 'agent_output' && e.stage === 'done');
  return { events, calls, opens, done: done?.payload as { content: string; reviewerOverruled?: boolean } | undefined };
}

describe('rework-cap gate on the wire', () => {
  it('opens at stage review with the last review notes, and Accept anyway releases without sign-off', async () => {
    const { opens, done, events } = await run({ answers: ['Accept anyway'] });
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      stage: 'review',
      payload: {
        prompt: 'The reviewer still rejects this answer after 2 reworks. What now?',
        detail: 'notes 2',
        options: ['Accept anyway', 'Retry on a stronger model', 'Stop'],
      },
    });
    expect(events.find((e) => e.type === 'gate_closed')!.stage).toBe('review');
    expect(done).toEqual({ content: 'draft 2', reviewerOverruled: true });
    expect(events.filter((e) => e.stage === 'sign-off')).toEqual([]);
  });

  it('Retry escalates one rework, then asks for sign-off once the review approves', async () => {
    const { calls, opens, done } = await run({ answers: ['Retry on a stronger model', 'Approve'], approvesAt: 3 });
    expect(calls.map((c) => !!c.call.escalate)).toEqual([false, false, false, true]);
    expect(calls[3].task.context).toContain('Reviewer notes to address: notes 2');
    expect(opens.map((e) => e.stage)).toEqual(['review', 'sign-off']);
    expect(done!.content).toBe('draft 3');
    expect(done!.reviewerOverruled).toBeUndefined();
  });

  it('Stop ends at done without releasing the answer', async () => {
    const { done } = await run({ answers: ['Stop'] });
    expect(done!.content).toBe('Stopped at review. The answer was not released.');
  });

  it('stops after 12 hours with no answer', async () => {
    const { done, events } = await run({ answers: ['timeout'] });
    const open = events.find((e) => e.type === 'gate_open')!;
    const closed = events.find((e) => e.type === 'gate_closed')!;
    expect(closed.payload).toMatchObject({ optionIndex: 2, timedOut: true });
    expect(closed.timestamp - open.timestamp).toBe(12 * 3600);
    expect(done!.content).toBe('Stopped at review. The answer was not released.');
  });

  it('offers no retry when the worker has no escalation model', async () => {
    const { opens } = await run({ answers: ['Stop'], escalation: false });
    expect((opens[0].payload as { options: string[] }).options).toEqual(['Accept anyway', 'Stop']);
  });
});

describe('every turn ends', () => {
  const cases: Array<[NonNullable<Opts['throwIn']>, string[]]> = [
    ['agent', []],
    ['review', []],
    ['rework', []],
    ['escalated', ['Retry on a stronger model']],
    ['escalation lookup', []],
  ];
  for (const [throwIn, answers] of cases) {
    it(`ends in one terminal_failure when the ${throwIn} call throws`, async () => {
      const { events, done } = await run({ answers, throwIn });
      expect(events.filter((e) => e.type === 'terminal_failure')).toHaveLength(1);
      expect(done).toBeUndefined();
    });
  }
});
