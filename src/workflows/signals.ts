// Shared Temporal signal and query identities for the multi-agent workflows.
//
// Kept in their own file so both workflow modules AND src/client.ts can import
// the SAME signal/query objects — Temporal compares by identity (.name) so
// re-declaration in two places would be a sneaky bug.

import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { UserInputSignal } from '@threadbase/agent-types';

export const userInputSignal = defineSignal<[UserInputSignal]>('userInput');

/** Current high-level stage of the orchestrator (or the active turn). */
export const stageQuery = defineQuery<string>('stage');

/** Number of turns enqueued but not yet processing (0 when idle). */
export const queueDepthQuery = defineQuery<number>('queueDepth');
