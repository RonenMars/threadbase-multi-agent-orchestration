// packages/agent-types/src/progress.ts
import type { Stage } from './stage';

/**
 * The three event kinds the worker may emit to tb-streamer over the webhook.
 *
 * - stage_transition: the workflow has moved to a new stage. Carries `stage`,
 *   and `reworkAttempt` when `stage === 'rework'`.
 * - agent_output: an agent (worker / reviewer / sign-off) has produced an
 *   output block to surface to the UI as a chat message. Carries an
 *   `AgentOutputPayload` in `payload`.
 * - terminal_failure: the turn has failed and will not produce more output.
 *   Carries a free-form reason in `payload`.
 */
export type ProgressEventType =
  | 'stage_transition'
  | 'agent_output'
  | 'terminal_failure';

/**
 * The envelope worker activities POST to tb-streamer's webhook receiver.
 *
 * Identity:
 * - `sessionId` routes the event to the right WebSocket connection.
 * - `turnId` groups events that belong to the same user turn.
 * - `eventId` is the dedupe key. MUST be generated in workflow code via
 *   `workflow.uuid4()` so it survives Temporal replay — see spec §7.6.
 * - `seq` is monotonic within a turn for stable ordering.
 *
 * Wire compatibility:
 * - `stage` is typed as `Stage` here (the package owns the enum), but the
 *   webhook receiver accepts it as `string` for additive compatibility, so
 *   the server can ship a new stage value without the client needing a
 *   coordinated release.
 */
export interface ProgressEvent {
  sessionId: string;
  turnId: string;
  eventId: string;
  seq: number;
  type: ProgressEventType;
  stage?: Stage;
  reworkAttempt?: number;
  timestamp: number;
  payload?: Record<string, unknown>;
}

/**
 * Payload of an `agent_output` event. Stored in `ProgressEvent.payload`.
 *
 * - `content` is the body of the chat block the UI will render.
 * - `partial` is reserved for a future streaming-token mode; in milestone B
 *   blocks are always complete on emission, so this is always undefined.
 * - `reviewerOverruled` is set on the FINAL agent_output when the rework
 *   cap was hit and the answer is being delivered without reviewer approval.
 *   See spec §7.4.
 */
export interface AgentOutputPayload {
  content: string;
  partial?: boolean;
  reviewerOverruled?: boolean;
}
