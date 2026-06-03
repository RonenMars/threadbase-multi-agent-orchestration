// src/workflows/orchestrator.ts
//
// LONG-LIVED workflow per session. Holds a serialized queue of user inputs and
// spawns a one-shot child `turnWorkflow` for each. Catches child failures so
// the session survives a bad turn.

import {
  proxyActivities,
  setHandler,
  setSignalHandler, // ← preserved for clarity (alias)
  condition,
  uuid4,
  executeChild,
  ChildWorkflowFailure,
  CancelledFailure,
  isCancellation,
} from '@temporalio/workflow';
import type { ProgressEvent, UserInputSignal } from '@threadbase/agent-types';

import type * as progressActivities from '../activities/progress';
import {
  userInputSignal,
  stageQuery,
  queueDepthQuery,
} from './signals';
import { turnWorkflow } from './turn';

const { sendProgressEvent } = proxyActivities<typeof progressActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 1 },
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * @param sessionId  tb-streamer's session id (used as the routing key on the
 *                   webhook and as part of the workflowId by convention).
 */
export async function orchestratorWorkflow(sessionId: string): Promise<void> {
  const queue: UserInputSignal[] = [];
  let currentTurnId: string | undefined;
  let stage: string = 'thinking';

  setHandler(stageQuery, () => currentTurnId ? stage : 'idle');
  setHandler(queueDepthQuery, () => queue.length);

  setHandler(userInputSignal, async (sig: UserInputSignal) => {
    queue.push(sig);
    // Spec §7.2: emit a `queued` stage_transition for any signal that won't
    // start immediately. That's either:
    //   - a turn is already running, OR
    //   - other turns are ahead in the queue (e.g. both signals arrived in the
    //     same workflow task before the main loop drained any of them).
    if (currentTurnId !== undefined || queue.length > 1) {
      const ev: ProgressEvent = {
        sessionId,
        turnId: sig.turnId,
        eventId: uuid4(),
        seq: 0,
        type: 'stage_transition',
        stage: 'queued',
        timestamp: nowSeconds(),
      };
      await sendProgressEvent(ev);
    }
  });

  // Main loop. Cancel the workflow to end the session.
  try {
    while (true) {
      await condition(() => queue.length > 0);
      const sig = queue.shift()!;
      currentTurnId = sig.turnId;
      stage = 'processing';

      try {
        await executeChild(turnWorkflow, {
          workflowId: `turn-${sig.turnId}`,
          args: [{
            sessionId,
            turnId: sig.turnId,
            prompt: sig.prompt,
            conversationHistory: sig.conversationHistory,
          }],
        });
      } catch (err) {
        if (err instanceof CancelledFailure || isCancellation(err)) {
          throw err; // propagate session cancellation
        }
        if (err instanceof ChildWorkflowFailure) {
          // Spec §7.5: catch and continue. Emit a per-turn terminal_failure;
          // do NOT touch session status.
          const ev: ProgressEvent = {
            sessionId,
            turnId: sig.turnId,
            eventId: uuid4(),
            seq: 0,
            type: 'terminal_failure',
            timestamp: nowSeconds(),
            payload: { reason: String((err as ChildWorkflowFailure).cause?.message ?? (err as Error).message) },
          };
          await sendProgressEvent(ev);
        } else {
          // Unexpected non-child failure (orchestrator-side bug). Re-throw —
          // spec §7.5 says session-level `failed` is reserved for this case.
          throw err;
        }
      } finally {
        currentTurnId = undefined;
        stage = 'thinking';
      }
    }
  } catch (err) {
    // If we got cancelled (session ending), exit cleanly.
    if (err instanceof CancelledFailure || isCancellation(err)) return;
    throw err;
  }
}

// Silence the unused-import linter for the alias preserved at top.
void setSignalHandler;
