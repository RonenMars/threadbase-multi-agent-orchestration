// packages/agent-types/src/signal.ts

/**
 * One entry in the conversationHistory snapshot.
 *
 * Owned by tb-streamer in milestone B — tb-streamer composes the snapshot from
 * its existing ConversationCache (SQLite-backed). The shape is mirrored here so
 * the signal payload has a stable wire type.
 *
 * Additional fields (timestamp, metadata, tool calls) may be added without
 * breaking compatibility: the orchestrator only forwards the snapshot through
 * to activities, it does not inspect entry shape.
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Payload sent by tb-streamer with every `userInput` signal to a session's
 * long-lived orchestrator workflow.
 *
 * - `turnId` is allocated by tb-streamer per user message; it is the same
 *   turn id worn by every progress event the resulting turn emits.
 * - `prompt` is the user's message text.
 * - `conversationHistory` is a snapshot tb-streamer composes from its cache.
 *   It rides in the payload instead of living in workflow state — see
 *   spec §6.1 for the rationale (option B.1).
 */
export interface UserInputSignal {
  turnId: string;
  prompt: string;
  conversationHistory: ConversationTurn[];
}
