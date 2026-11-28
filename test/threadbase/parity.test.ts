// test/threadbase/parity.test.ts
//
// While the frozen `turnWorkflow` still exists, `pipelineWorkflow` must behave
// exactly like it: the same progress events in the same order, the same
// activity calls with the same arguments, and the same result. The one
// deliberate differences are the human gates, each answered with its first
// option here. The pipeline asks at sign-off where the turn called
// `productSignOff`, so both are left out. At the rework cap it asks instead of
// overruling, and Accept anyway releases without a sign-off stage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { nanoid } from 'nanoid';
import path from 'node:path';
import type { ConversationTurn, ProgressEvent } from '@threadbase-sh/agent-types';

import type { Draft, Review, Task } from '../../src/shared/types';
import { approvingGates } from './approve-gates';

let env: TestWorkflowEnvironment;
const workflowsPath = path.resolve(__dirname, '../../src/workflows/index.ts');

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await env?.teardown();
});

async function run(workflowType: 'turnWorkflow' | 'pipelineWorkflow', approvesAfter: number, history: ConversationTurn[]) {
  const calls: unknown[] = [];
  const events: unknown[] = [];
  let reviews = 0;
  let drafts = 0;
  const taskQueue = `tq-${nanoid(6)}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: {
      processTask: async (task: Task): Promise<Draft> => {
        calls.push(['processTask', task]);
        return { taskId: task.id, content: `draft ${drafts++}` };
      },
      reviewTask: async (draft: Draft): Promise<Review> => {
        calls.push(['reviewTask', draft]);
        const approved = reviews >= approvesAfter;
        // Alternate empty and non-empty notes to cover the review content fallback.
        const notes = approved ? (reviews % 2 ? 'fine' : '') : `fix ${reviews}`;
        reviews += 1;
        return { taskId: draft.taskId, approved, notes };
      },
      escalationAvailable: async () => true,
      productSignOff: async (draft: Draft, review: Review) => {
        calls.push(['productSignOff', draft, review]);
        return review.approved;
      },
      sendProgressEvent: approvingGates(env.client, async ({ eventId, timestamp, ...ev }: ProgressEvent) => {
        expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(typeof timestamp).toBe('number');
        events.push(ev);
      }),
    },
  });
  return worker.runUntil(async () => {
    const handle = await env.client.workflow.start(workflowType, {
      taskQueue,
      workflowId: `turn-${nanoid(6)}`,
      args: [{ sessionId: 'sess-parity', turnId: 'turn-parity', prompt: 'do it', conversationHistory: history }],
    });
    const result = await handle.result();
    const stage = await handle.query<string>('stage');
    return { calls, events, result, stage };
  });
}

const isGate = (e: unknown) => String((e as { type: string }).type).startsWith('gate_');
const withoutSignOff = (r: Awaited<ReturnType<typeof run>>) => ({
  ...r,
  calls: r.calls.filter((c) => (c as unknown[])[0] !== 'productSignOff'),
  // The gate events take two seq numbers; order is still compared.
  events: r.events.filter((e) => !isGate(e)).map((e) => ({ ...(e as object), seq: undefined })),
});

describe('pipelineWorkflow matches turnWorkflow', () => {
  const history: ConversationTurn[] = [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
  ];

  for (const approvesAfter of [0, 1, 2, 3]) {
    for (const h of [[], history]) {
      it(`reviewer approves after ${approvesAfter} rejections, ${h.length} history turns`, async () => {
        const before = await run('turnWorkflow', approvesAfter, h);
        const after = await run('pipelineWorkflow', approvesAfter, h);
        expect(before.stage).toBe('done');
        expect(after.events.filter(isGate).map((e) => e.type)).toEqual(['gate_open', 'gate_closed']);
        const expected = withoutSignOff(before);
        if (approvesAfter === 3) {
          expected.events = expected.events.filter((e) => (e as { stage?: string }).stage !== 'sign-off');
        }
        expect(withoutSignOff(after)).toEqual(expected);
      });
    }
  }
});
