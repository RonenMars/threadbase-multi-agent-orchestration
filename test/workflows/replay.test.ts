// test/workflows/replay.test.ts
//
// Replays histories recorded from the code at fa9bc0e (before the pipeline
// child existed) against today's workflow bundle. A session that started on
// that code must keep replaying: its turns ran as `turnWorkflow` children, so
// the orchestrator has to keep choosing `turnWorkflow` for them.
//
// The fixtures hold one session with two turns (the first reworked once, the
// second queued behind it), then cancelled, plus the first turn's own history.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { nanoid } from 'nanoid';
import type { ProgressEvent } from '@threadbase-sh/agent-types';
import { approvingGates } from '../threadbase/approve-gates';

const workflowsPath = path.resolve(__dirname, '../../src/workflows/index.ts');

function loadHistory(name: string): temporal.api.history.v1.History {
  const json = readFileSync(path.resolve(__dirname, '../fixtures', name), 'utf8');
  return temporal.api.history.v1.History.fromObject(JSON.parse(json));
}

describe('replay of histories recorded before the pipeline child', () => {
  it('replays an orchestrator session whose turns ran as turnWorkflow', async () => {
    await Worker.runReplayHistory(
      { workflowsPath },
      loadHistory('orchestrator-history.json'),
      'session-sess-record',
    );
  });

  it('replays a pipelineWorkflow turn recorded before the human sign-off gate', async () => {
    await Worker.runReplayHistory(
      { workflowsPath },
      loadHistory('pipeline-auto-sign-off-history.json'),
      'turn-turn-auto',
    );
  });

  // Recorded at aae73d3: the reviewer never approved, and the turn went on to sign-off.
  it('replays an overruled turn recorded before the rework-cap gate', async () => {
    await Worker.runReplayHistory(
      { workflowsPath },
      loadHistory('pipeline-overruled-history.json'),
      'turn-turn-overruled',
    );
  });

  it('replays a turnWorkflow that was in flight', async () => {
    await Worker.runReplayHistory(
      { workflowsPath },
      loadHistory('turn-history.json'),
      'turn-turn-1',
    );
  });
});

describe('a session started on this code', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  it('runs its turns as pipelineWorkflow, and its history replays', async () => {
    const emitted: ProgressEvent[] = [];
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
        sendProgressEvent: approvingGates(env.client, async (ev: ProgressEvent) => { emitted.push(ev); }),
      },
    });
    const handle = await env.client.workflow.start('orchestratorWorkflow', {
      taskQueue,
      workflowId: `session-${sessionId}`,
      args: [sessionId],
    });
    const done = (turnId: string) => emitted.some((e) => e.turnId === turnId && e.stage === 'done');

    await worker.runUntil(async () => {
      for (const turnId of ['turn-x', 'turn-y']) {
        await handle.signal('userInput', { turnId, prompt: 'p', conversationHistory: [] });
        while (!done(turnId)) await new Promise((r) => setTimeout(r, 50));
      }
      await handle.cancel();
      await handle.result();
    });

    for (const turnId of ['turn-x', 'turn-y']) {
      const child = await env.client.workflow.getHandle(`turn-${turnId}`).describe();
      expect(child.type).toBe('pipelineWorkflow');
    }
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
  });
});
