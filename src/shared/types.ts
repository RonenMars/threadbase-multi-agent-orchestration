// Shared domain types passed between the backend, workflows, and activities.
// Everything here must be plain, JSON-serializable data — Temporal serializes
// workflow inputs/outputs and activity args across process boundaries.

export interface Task {
  id: string;
  sessionId: string; // ties back to a Threadbase session / WebSocket channel
  prompt: string;
  context?: string;
}

export interface Draft {
  taskId: string;
  content: string;
}

export interface Review {
  taskId: string;
  approved: boolean;
  notes: string;
}

export interface Result {
  taskId: string;
  content: string;
  review: Review;
  reworkAttempts: number;
}

import type { ConversationTurn } from '@threadbase/agent-types';

/**
 * Per-turn child workflow input. The orchestrator passes this when starting a
 * `turnWorkflow`. It is built by stitching the user's prompt onto a snapshot
 * of conversation history that tb-streamer composed.
 */
export interface TurnInput {
  sessionId: string;
  turnId: string;
  prompt: string;
  conversationHistory: ConversationTurn[];
}
