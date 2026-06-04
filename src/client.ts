// src/client.ts
//
// Temporal client helpers used by tb-streamer (and by the local smoke scripts).
//
// Two public surfaces:
// - Session API (multi-agent mode): startSession + sendUserInput.
// - Legacy task API (single-shot for ad-hoc smoke): startTask + getStage + awaitResult.
//   The legacy API is kept so the existing `smoke:task` script still works.

import { Connection, Client } from '@temporalio/client';
import { config } from './shared/config';
import {
  orchestratorWorkflow,
  turnWorkflow,
  stageQuery,
  userInputSignal,
} from './workflows';
import type { UserInputSignal } from '@threadbase/agent-types';
import type { TurnInput } from './shared/types';

let client: Client | undefined;

export async function getClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({ address: config.address });
    client = new Client({ connection, namespace: config.namespace });
  }
  return client;
}

const sessionWorkflowId = (sessionId: string): string => `session-${sessionId}`;

// ─── multi-agent session API ──────────────────────────────────────────────

/**
 * Start the long-lived orchestrator workflow for a session. Idempotent on the
 * Temporal side: starting twice with the same sessionId is a no-op because of
 * the workflowId reuse policy.
 */
export async function startSession(sessionId: string): Promise<string> {
  const c = await getClient();
  const handle = await c.workflow.start(orchestratorWorkflow, {
    taskQueue: config.taskQueue,
    workflowId: sessionWorkflowId(sessionId),
    args: [sessionId],
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
  });
  return handle.workflowId;
}

/** Send a user message to a running session. */
export async function sendUserInput(sessionId: string, signal: UserInputSignal): Promise<void> {
  const c = await getClient();
  await c.workflow.getHandle(sessionWorkflowId(sessionId)).signal(userInputSignal, signal);
}

/** Cancel a session (cleanly ends the orchestrator workflow). */
export async function endSession(sessionId: string): Promise<void> {
  const c = await getClient();
  await c.workflow.getHandle(sessionWorkflowId(sessionId)).cancel();
}

/** Query the orchestrator's current stage (returns 'idle' when no turn is active). */
export async function getSessionStage(sessionId: string): Promise<string> {
  const c = await getClient();
  return c.workflow.getHandle(sessionWorkflowId(sessionId)).query(stageQuery);
}

// ─── legacy single-turn API (smoke only) ─────────────────────────────────

export async function startTurn(turnInput: TurnInput): Promise<string> {
  const c = await getClient();
  const handle = await c.workflow.start(turnWorkflow, {
    taskQueue: config.taskQueue,
    workflowId: `turn-${turnInput.turnId}`,
    args: [turnInput],
  });
  return handle.workflowId;
}

export async function awaitTurnResult(turnId: string) {
  const c = await getClient();
  return c.workflow.getHandle(`turn-${turnId}`).result();
}

export async function getTurnStage(turnId: string): Promise<string> {
  const c = await getClient();
  return c.workflow.getHandle(`turn-${turnId}`).query(stageQuery);
}
