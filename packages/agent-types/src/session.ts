// packages/agent-types/src/session.ts
import type { Stage } from './stage';

/**
 * Fields added to tb-streamer's existing session shape (and the
 * `session_update` WebSocket event) for multi-agent mode.
 *
 * Every field is optional so this remains additive — existing mobile clients
 * that don't know about `stage` keep working; new clients can render
 * per-stage UI affordances.
 *
 * - `stage` widens to `string` on the wire so the worker can ship a new
 *   stage value before clients are updated. Internally we type it as
 *   `Stage | string` to keep autocomplete + literal-checking on the
 *   producer side.
 * - `stalledSinceMs` is the number of milliseconds the session has been on
 *   the current stage without progress. The frontend uses it to surface
 *   "still working…" or to flag a hang.
 * - `reworkAttempt` is only meaningful when `stage === 'rework'`.
 */
export interface SessionStageAddendum {
  stage?: Stage | string;
  stalledSinceMs?: number;
  reworkAttempt?: number;
}
