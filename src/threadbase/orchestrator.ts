// src/threadbase/orchestrator.ts
//
// LONG-LIVED workflow per session. Holds a serialized queue of user inputs and
// spawns a one-shot child `pipelineWorkflow` for each. Catches child failures so
// the session survives a bad turn.

import {
  proxyActivities,
  setHandler,
  condition,
  uuid4,
  executeChild,
  ChildWorkflowFailure,
  CancelledFailure,
  isCancellation,
  log,
  patched,
  workflowInfo,
  allHandlersFinished,
  continueAsNew,
} from '@temporalio/workflow';
import type { ProgressEvent, UserInputSignal } from '@threadbase-sh/agent-types';

import type * as progressActivities from './progress';
import {
  userInputSignal,
  stageQuery,
  queueDepthQuery,
} from './signals';
import { turnWorkflow } from '../workflows/turn';
import { pipelineWorkflow } from './pipeline';

const { sendProgressEvent } = proxyActivities<typeof progressActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 1 },
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// A run continues as new after this many turns, or once its history passes
// MAX_HISTORY_EVENTS. A turn costs about 13 events, so the event limit only
// trips when a flood of inputs queues up behind one turn.
const MAX_TURNS_PER_RUN = 20;
const MAX_HISTORY_EVENTS = 500;

/** State one run hands to the next when it continues as new. */
export interface OrchestratorCarry {
  /** Inputs still waiting. Each already got its `queued` event. */
  queue: UserInputSignal[];
}

/**
 * @param sessionId  tb-streamer's session id (used as the routing key on the
 *                   webhook and as part of the workflowId by convention).
 * @param carry      Set only by continue-as-new; the streamer starts with
 *                   `[sessionId]` alone.
 */
export async function orchestratorWorkflow(sessionId: string, carry?: OrchestratorCarry): Promise<void> {
  const queue: UserInputSignal[] = carry?.queue ?? [];
  let turnsThisRun = 0;
  let currentTurnId: string | undefined;
  let stage: string = 'thinking';

  log.info('orchestrator session started', { sessionId });

  setHandler(stageQuery, () => currentTurnId ? stage : 'idle');
  setHandler(queueDepthQuery, () => queue.length);

  setHandler(userInputSignal, async (sig: UserInputSignal) => {
    queue.push(sig);
    const willBeQueued = currentTurnId !== undefined || queue.length > 1;
    log.info('userInput signal received', {
      sessionId,
      turnId: sig.turnId,
      queueDepth: queue.length,
      willBeQueued,
    });
    // Spec §7.2: emit a `queued` stage_transition for any signal that won't
    // start immediately. That's either:
    //   - a turn is already running, OR
    //   - other turns are ahead in the queue (e.g. both signals arrived in the
    //     same workflow task before the main loop drained any of them).
    if (willBeQueued) {
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
      // Between turns only. Sessions that started before this patch replay
      // their recorded turns without it.
      if (
        patched('continue-as-new') &&
        (turnsThisRun >= MAX_TURNS_PER_RUN || workflowInfo().historyLength > MAX_HISTORY_EVENTS)
      ) {
        // Let a `userInput` handler finish its `queued` event first.
        await condition(allHandlersFinished);
        log.info('orchestrator continuing as new', { sessionId, turnsThisRun, queueDepth: queue.length });
        await continueAsNew<typeof orchestratorWorkflow>(sessionId, { queue });
      }
      await condition(() => queue.length > 0);
      const sig = queue.shift()!;
      turnsThisRun++;
      currentTurnId = sig.turnId;
      stage = 'processing';
      log.info('dispatching child turn workflow', {
        sessionId,
        turnId: sig.turnId,
        queueDepth: queue.length,
      });

      try {
        // Sessions that started before the pipeline child keep replaying their
        // recorded turns as `turnWorkflow`; every new turn runs the pipeline.
        await executeChild(patched('pipeline-child') ? pipelineWorkflow : turnWorkflow, {
          workflowId: `turn-${sig.turnId}`,
          args: [{
            sessionId,
            turnId: sig.turnId,
            prompt: sig.prompt,
            conversationHistory: sig.conversationHistory,
          }],
        });
        log.info('child turn workflow completed', { sessionId, turnId: sig.turnId });
      } catch (err) {
        if (err instanceof CancelledFailure || isCancellation(err)) {
          throw err; // propagate session cancellation
        }
        if (err instanceof ChildWorkflowFailure) {
          // Spec §7.5: catch and continue. Emit a per-turn terminal_failure;
          // do NOT touch session status.
          const reason = String(
            (err as ChildWorkflowFailure).cause?.message ?? (err as Error).message,
          );
          log.warn('child turn workflow failed; emitting terminal_failure', {
            sessionId,
            turnId: sig.turnId,
            reason,
          });
          const ev: ProgressEvent = {
            sessionId,
            turnId: sig.turnId,
            eventId: uuid4(),
            seq: 0,
            type: 'terminal_failure',
            timestamp: nowSeconds(),
            payload: { reason },
          };
          await sendProgressEvent(ev);
        } else {
          // Unexpected non-child failure (orchestrator-side bug). Re-throw —
          // spec §7.5 says session-level `failed` is reserved for this case.
          log.error('orchestrator-level failure (re-throwing to fail session)', {
            sessionId,
            turnId: sig.turnId,
          });
          throw err;
        }
      } finally {
        currentTurnId = undefined;
        stage = 'thinking';
      }
    }
  } catch (err) {
    // If we got cancelled (session ending), exit cleanly.
    if (err instanceof CancelledFailure || isCancellation(err)) {
      log.info('orchestrator session cancelled cleanly', { sessionId });
      return;
    }
    throw err;
  }
}

