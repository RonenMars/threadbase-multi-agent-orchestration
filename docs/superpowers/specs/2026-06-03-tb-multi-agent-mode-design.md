# tb-multi-agent mode — design spec

**Date:** 2026-06-03
**Status:** Approved for implementation planning
**Milestone:** B (multi-agent mode for tb-streamer)

---

## 1. Goal

Add a new operating mode to tb-streamer in which user input is routed to a Temporal-orchestrated multi-agent pipeline (worker → reviewer → sign-off) instead of node-pty Claude Code. The new mode runs alongside the existing PTY mode as a separate process; mode selection is process-wide.

Milestone B ships:

- A long-lived **orchestrator workflow** per session (Tier 1) that receives `userInput` signals and serializes turns.
- A one-shot **child workflow per turn** (Tier 2) that runs today's `taskPipelineWorkflow` (worker → reviewer → optional rework → sign-off).
- A **signed HTTP webhook** side-channel from worker activities to tb-streamer for live progress events.
- An **additive stage field** on the existing session shape and `session_update` events, using a fixed enum.
- Wiring on the tb-streamer side: process flag, webhook receiver, session integration with the existing WebSocket hub, conversation persistence via the existing JSONL pipeline.

Out of scope for this milestone (captured in `docs/ROADMAP.md`):

- LLM-as-orchestrator (orchestrator picks tools dynamically).
- `continueAsNew` checkpointing in the long-lived orchestrator.
- Postgres-backed progress event dedupe (option D).
- Rework escalation path (human-in-loop / stronger model).
- Promoting `@threadbase/agent-types` past the local `file:` stage.
- Workflow-state promotion from cache-only (B.1) to compact summary + recent-turn buffer.

---

## 2. Decisions locked

| # | Topic | Decision |
|---|---|---|
| 1 | Mode shape | Process-wide flag `--multi-agent-flow` (or `MULTI_AGENT_FLOW=true`). When ON, PTY mode is unreachable from this process. Run two streamers to compare modes side by side. |
| 2 | Orchestrator style | Hard-coded pipeline (extend `taskPipelineWorkflow`). LLM-as-orchestrator deferred. |
| 3 | User-facing streaming | Per-step output blocks — each activity emits its output on completion via the webhook side-channel. No token streaming. Stage transitions also emitted. |
| 4 | Topology | Two separate processes: tb-streamer = Temporal client, tb-multi-agent = workflow + worker. Shared types in new package `@threadbase/agent-types`. |
| 5 | Session lifecycle | Tier 1 long-lived orchestrator (per session) holds the big picture and receives signals. Tier 2 one-shot child workflows (per turn) run the pipeline. `continueAsNew` deferred. |
| 6 | Shared package | Stage 1 (local `file:` dep) for milestone B. Submodule + npm publish deferred. |
| 7 | Conversation history | Option B.1: JSONL written by tb-streamer (NOT the worker), existing `ConversationCache` ingests it. Orchestrator workflow holds NO `conversationHistory` state — the snapshot rides in each signal payload. |
| 8 | Session status vocabulary | Keep the 5 mobile-pinned statuses (`running`, `waiting_input`, `completed`, `failed`, `on_hold`). Add an additive optional `stage: string` field on session shape + `session_update` events. Add `stalledSinceMs?: number` for frontend hang-detection. |
| 9 | Stage enum | `thinking | queued | processing | review | rework | sign-off | done`. Declared in `@threadbase/agent-types`; widened to `string` on the wire (additive compatibility). `rework` carries a separate `reworkAttempt: number` field. |
| 10 | Side-channel | Signed HTTP webhook (HMAC-SHA256) — see `signed-http-webhook-guide.md` for the full transport design. |
| 11 | Event idempotency | Per-session in-memory dedupe map on tb-streamer's session record. (See [§7.1](#71-event-idempotency).) |
| 12 | Signal ordering | Orchestrator serializes turns — second `userInput` while a turn is running is queued. UI sees stage `queued`. (See [§7.2](#72-signal-ordering--concurrent-turns).) |
| 13 | Webhook disconnect | Worker: 2–3 attempt short retry window, never fail the activity, no buffered replay. UI catch-up via state query + JSONL on reconnect. (See [§7.3](#73-worker--tb-streamer-disconnect).) |
| 14 | Max rework | Hard cap of 2 rework attempts. At cap, emit last draft as the answer with `reviewerOverruled: true` flag. Counter lives on the child workflow. (See [§7.4](#74-max-rework).) |
| 15 | Child workflow failure | Orchestrator catches `ChildWorkflowFailure`, emits per-turn `terminal_failure` event, stays alive for next signal. Session `status: failed` is reserved for orchestrator-level unrecoverability only — per-turn failures never touch session status. (See [§7.5](#75-child-workflow-failure).) |
| 16 | Restart mid-turn | Restart gap invisible to UI; frontend uses `stalledSinceMs`. `eventId` generated in workflow code with `workflow.uuid4()` for replay-safe dedupe. Dual-process restart (worker + tb-streamer) is the accepted failure mode for option B and is documented as deferred to D. (See [§7.6](#76-orchestrator-restart-mid-turn).) |

---

## 3. Architecture

### 3.1 Processes

```
┌────────────────────────────────────┐         ┌────────────────────────────────┐
│  tb-streamer (multi-agent mode)    │         │  tb-multi-agent worker         │
│  ─ Temporal client                 │ start   │  ─ Temporal worker             │
│  ─ WebSocket hub (existing)        │────────▶│  ─ Workflows + Activities      │
│  ─ Webhook receiver (NEW)          │ signal  │  ─ Calls Anthropic             │
│  ─ JSONL writer (NEW)              │◀────────│  ─ POSTs to webhook receiver   │
│  ─ ConversationCache (existing)    │ webhook │                                │
└────────────────────────────────────┘         └───────────────┬────────────────┘
              ▲                                                │
              │ WebSocket                                      │
              │                                                ▼
        ┌─────┴──────┐                            ┌──────────────────────┐
        │  Frontend  │                            │   Temporal Server    │
        │ (mobile)   │                            │   (dev: CLI dev)     │
        └────────────┘                            └──────────────────────┘
```

Two separate processes. `tb-streamer` does not import anything from `tb-multi-agent` at runtime; both processes import `@threadbase/agent-types` for the wire types.

### 3.2 Sequence — one turn

```
User sends a message
    │
    ▼
tb-streamer receives WebSocket frame
    │
    ▼ compose conversationHistory snapshot from ConversationCache
    │
    ▼ Temporal: signal orchestratorWorkflow with `userInput`
    │
    ▼ orchestrator dequeues signal, starts childWorkflow (turn)
    │       │
    │       ▼ activity: processTask (worker agent)
    │       │       │
    │       │       ▼ POST /internal/sessions/:sessionId/progress
    │       │         { type: 'stage_transition', stage: 'processing' }
    │       │       ▼ POST /internal/.../progress
    │       │         { type: 'agent_output', payload: { draft } }
    │       ▼ activity: reviewTask
    │       │       ▼ stage_transition: 'review'
    │       │       ▼ agent_output: { review }
    │       ▼ (optional rework loop, capped at 2)
    │       │       ▼ stage_transition: 'rework', reworkAttempt: N
    │       ▼ activity: productSignOff
    │       │       ▼ stage_transition: 'sign-off'
    │       ▼ stage_transition: 'done'
    │       ▼ activity: emitFinalAnswer (POSTs final `agent_output`)
    │
    ▼ orchestrator marks turn complete, ready for next signal
    │
    ▼ tb-streamer webhook handler forwards events to WebSocket
    │
    ▼ tb-streamer writes the assistant turn to JSONL
    │
    ▼ ConversationCache ingests the JSONL line (existing pipeline)
```

### 3.3 Wire shapes (declared in `@threadbase/agent-types`)

```ts
// Stage enum (internal type safety; widened to string on the wire)
export const STAGES = [
  'thinking', 'queued', 'processing', 'review', 'rework', 'sign-off', 'done',
] as const;
export type Stage = typeof STAGES[number];

// Progress event envelope — exactly matches signed-http-webhook-guide.md
export type ProgressEventType =
  | 'stage_transition'
  | 'agent_output'
  | 'terminal_failure';

export interface ProgressEvent {
  sessionId: string;
  turnId: string;
  eventId: string;        // unique per event, replay-safe (workflow.uuid4)
  seq: number;            // monotonic within a turn
  type: ProgressEventType;
  stage?: Stage;          // present on stage_transition
  reworkAttempt?: number; // present when stage === 'rework'
  timestamp: number;      // unix seconds
  payload?: Record<string, unknown>;
}

// One entry in the conversationHistory snapshot. Owned by tb-streamer
// (it composes the snapshot from ConversationCache). Mirrored here so the
// signal payload has a stable wire type.
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  // Additional fields (timestamp, metadata) may be added without breaking
  // wire compat — the orchestrator only routes the snapshot through to
  // activities; it does not inspect entry shape.
}

// Signal payload — sent on every userInput
export interface UserInputSignal {
  turnId: string;
  prompt: string;
  conversationHistory: ConversationTurn[]; // composed by tb-streamer from cache
}

// Session shape additions (additive — backward compatible)
export interface SessionStageAddendum {
  stage?: Stage | string;        // widened to string on the wire
  stalledSinceMs?: number;       // null/undef when actively progressing
  reworkAttempt?: number;        // only when stage === 'rework'
}

// Final answer flag for reviewer-overruled case
export interface AgentOutputPayload {
  content: string;
  partial?: boolean;
  reviewerOverruled?: boolean;
}
```

---

## 4. Components

### 4.1 tb-multi-agent (this repo)

| Module | Responsibility |
|---|---|
| `src/workflows/orchestrator.ts` (NEW) | Long-lived per-session workflow. Maintains a serialized signal queue. Spawns child workflows one turn at a time. Catches `ChildWorkflowFailure` and continues. |
| `src/workflows/turn.ts` (RENAMED from existing `taskPipelineWorkflow`) | One-shot per-turn child workflow. Owns the worker→reviewer→rework→sign-off pipeline. Tracks `reworkAttempt`. Generates `eventId`s via `workflow.uuid4()`. |
| `src/activities/agents.ts` (REFACTOR of existing `activities.ts`) | `processTask`, `reviewTask`, `productSignOff`. Each emits `agent_output` via the webhook helper after completing. |
| `src/activities/progress.ts` (NEW) | `sendProgressEvent(event)` — HTTP POST + HMAC + short-retry-window. Logs failures, never throws back into the workflow. |
| `src/worker.ts` (EXISTING) | Loads both workflows and all activities. |
| `src/starter.ts` (EXISTING, REPURPOSED) | Becomes a thin smoke-test starter for local dev — not used at runtime by tb-streamer. |
| `src/shared/load-env.ts` (EXISTING) | Keep as-is. Side-effect dotenv loader with `override: true`, imported FIRST in worker.ts. |
| `packages/agent-types/` (NEW, local `file:` dep) | The shared types from §3.3. Linked into tb-streamer via a relative `file:` path during milestone B. |

### 4.2 tb-streamer (companion repo)

| Module | Change |
|---|---|
| `cli/index.ts` (or `src/server.ts`) | Add `--multi-agent-flow` flag (also `MULTI_AGENT_FLOW=true` env). When ON, the PTY code path is unreachable for this process. |
| `src/api/routes/progress.ts` (NEW) | Hono route mounted at `POST /internal/sessions/:sessionId/progress`. Verifies HMAC, dedupes via per-session map, forwards to WebSocket hub. |
| `src/session-store.ts` (EXTEND) | Sessions in multi-agent mode carry a `progressDedupeIds: Set<string>` keyed by `eventId`. The set lives as long as the session. |
| `src/ws-hub.ts` (EXTEND) | Forward progress events to the session's WebSocket subscribers. Use the existing `session_update` event for stage changes; introduce one new event type `agent_output` for per-step output blocks. |
| `src/agent-client.ts` (NEW) | Thin Temporal client wrapper. `startSession(sessionId)` starts the orchestrator workflow; `sendUserInput(sessionId, payload)` signals it. |
| `src/conversation-writer.ts` (NEW or extend existing JSONL handling) | When a turn produces its final `agent_output`, write the assistant turn to JSONL. The existing `ConversationCache` ingests it. |

### 4.3 Why this carves up cleanly

- **tb-multi-agent owns the durable computation.** It does not know about WebSockets, JSONL, or mobile-pinned API shapes.
- **tb-streamer owns the user-facing surface.** WebSockets, JSONL, the session record, mobile contract. It calls into Temporal as a client; it does not host workflows.
- **The webhook is the only direct cross-process channel.** Even there, the contract is one direction (worker → tb-streamer) and one-shot per event.

---

## 5. Wire contracts

### 5.1 Webhook (worker → tb-streamer)

Full transport described in `signed-http-webhook-guide.md` (committed at repo root). Summary for cross-reference:

- **Endpoint:** `POST /internal/sessions/:sessionId/progress`
- **Headers:** `Content-Type: application/json`, `X-Progress-Signature: <hmac-sha256>`, `X-Progress-Timestamp: <unix-seconds>`, `X-Progress-Event-Id: <uuid>`
- **Body:** `ProgressEvent` from §3.3, serialized as JSON.
- **Auth:** HMAC-SHA256 over the raw body, using `PROGRESS_HMAC_SECRET`.
- **Idempotency:** `eventId` is the dedupe key. See §7.1.
- **Failure mode:** best-effort. Worker treats any non-2xx as fire-and-forget after retries (§7.3). tb-streamer 401s on bad signature, 200s on duplicate.

### 5.2 WebSocket additions (tb-streamer → frontend)

Two additive event types. Existing event shapes are unchanged.

| Event | When | Payload |
|---|---|---|
| `session_update` | Stage transition, status change, `stalledSinceMs` update | Existing shape + new optional `stage`, `stalledSinceMs`, `reworkAttempt` fields |
| `agent_output` (NEW) | Per-step output block from any agent | `{ sessionId, turnId, role: 'worker' | 'reviewer' | 'signoff', content: string, partial?: boolean, reviewerOverruled?: boolean }` |

Note on additivity: the 5 mobile-pinned status strings (`running | waiting_input | completed | failed | on_hold`) remain semantically identical. Frontends that don't know about `stage` will keep working — they just won't show per-step progress.

### 5.3 Temporal signals

```ts
import { defineSignal } from '@temporalio/workflow';
import type { UserInputSignal } from '@threadbase/agent-types';

export const userInputSignal = defineSignal<[UserInputSignal]>('userInput');
```

Sent by `tb-streamer` via the Temporal client every time the user sends a message. Orchestrator's signal handler pushes onto a workflow-local queue; the main loop drains one at a time (see §7.2).

---

## 6. Data flow

### 6.1 Conversation history

- Source of truth: **JSONL files** under the user's conversation directory (existing tb-streamer pattern).
- Cache: **`ConversationCache`** (SQLite) ingests JSONL via the existing `ConversationWatcher`. No new pipeline.
- Workflow state: **none.** The orchestrator workflow does NOT hold `conversationHistory`. Each `userInput` signal carries the snapshot tb-streamer composes from cache.
- Trade-off: every signal payload contains the full (or windowed) history. Acceptable for milestone B; revisit when history sizes warrant compaction. Promotion path documented in `docs/ROADMAP.md`.

### 6.2 Progress events

- Source: workflow code (stage transitions) and activity code (`agent_output` after each agent completes).
- Generation: `eventId` is `workflow.uuid4()` invoked inside the workflow, ensuring deterministic replay-safety. `seq` is a monotonic counter held in workflow state for the turn.
- Transport: HMAC-signed HTTP POST to tb-streamer.
- Sink: in-memory dedupe map on session record → WebSocket hub → mobile frontend.

### 6.3 Final answer

The final `agent_output` event (carrying the approved or `reviewerOverruled` draft) is the signal tb-streamer uses to write the assistant turn to JSONL. This means:

- **JSONL is written by tb-streamer**, not by the worker.
- **The webhook delivery semantics matter for completeness.** If the final webhook is lost, the JSONL write doesn't happen.
- **Mitigation:** the final webhook uses the same short-retry policy as all others. In the (rare) case it fails completely, the workflow result is still available via Temporal query — tb-streamer can reconcile from there if needed.

This is a known trade-off vs. having the worker write JSONL directly (which would invert the dependency between the processes). Documented for revisit if reliability becomes a concern.

---

## 7. Error and edge cases

### 7.1 Event idempotency

**Decision:** per-session in-memory dedupe map on tb-streamer's session record.

**Implementation:** Each session has a `progressDedupeIds: Set<string>`. The webhook handler does:

```ts
if (session.progressDedupeIds.has(event.eventId)) {
  return res.status(200).json({ ok: true, deduped: true });
}
session.progressDedupeIds.add(event.eventId);
// forward to WebSocket...
```

The set lives as long as the session does — when the WebSocket closes and the session record is GC'd, the dedupe set goes with it. No TTL policy needed.

**Failure mode (accepted):** tb-streamer process restart mid-session empties the dedupe map. If Temporal retries an activity *after* the restart, the retried event passes through as new. Single duplicate UI block per affected turn. Mitigation path: option D (Postgres unique-index), deferred — see `docs/plans/postgres-dedupe.md`.

### 7.2 Signal ordering — concurrent turns

**Decision:** orchestrator serializes turns.

**Implementation:**

```ts
const signalQueue: UserInputSignal[] = [];

setSignalHandler(userInputSignal, async (sig) => {
  signalQueue.push(sig);
  // Emit a `queued` stage_transition for the queued turn. This is the
  // signal that surfaces "your second message is waiting" to the UI.
  // The orchestrator emits progress events via the same activity helper
  // as child workflows do.
  if (signalQueue.length > 1) {
    await emitProgressEvent({
      sessionId, turnId: sig.turnId, type: 'stage_transition', stage: 'queued',
    });
  }
});

while (!sessionEnded) {
  await condition(() => signalQueue.length > 0);
  const sig = signalQueue.shift()!;
  try {
    await executeChild(turnWorkflow, { args: [sig] });
  } catch (err) {
    // see §7.5
  }
}
```

Two clarifications:

- **Orchestrator emits progress events too.** It uses the same `sendProgressEvent` activity as child workflows. The `queued` stage transition is emitted by the orchestrator when a signal arrives while a turn is already running — child workflows can't emit `queued` because they don't exist yet for the queued turn.
- **The first turn in a session does NOT get a `queued` event** — it starts immediately, so the first stage transition the UI sees is `processing` (emitted by the child workflow).

### 7.3 Worker → tb-streamer disconnect

**Three sub-decisions:**

1. **Transport retries:** 2–3 attempts with short backoff (e.g. 200ms, 800ms). ~1s total before giving up. Inside the activity's progress helper, not via Temporal activity retries.
2. **Activity failure semantics:** webhook failure NEVER fails the activity. The activity logs the failure and returns success. The LLM result is the activity's actual return value.
3. **UI catch-up on tb-streamer recovery:** no buffered replay from worker side. When the WebSocket reconnects, tb-streamer queries the workflow for current state via the Temporal `stageQuery` (already defined in the existing `taskPipelineWorkflow` and carried into the new `turnWorkflow`) — together with the orchestrator's session state — and emits one `session_update` event. Per-step `agent_output` blocks the user missed live in JSONL — the frontend reads them via the existing reconnect path.

This keeps the workflow stateless about UI, keeps the worker stateless about delivery, and leans on tb-streamer's existing reconcile paths.

### 7.4 Max rework

**Cap:** 2 rework attempts. Pipeline is: original draft → review → rework #1 → review → rework #2 → review → must finalize.

**At cap:** the workflow transitions `rework → sign-off → done` using the most recent draft. The final `agent_output` carries `reviewerOverruled: true`. The UI surfaces this so the user knows the answer wasn't reviewer-approved.

**Counter location:** per child workflow. Each turn starts fresh — a "noisy" session doesn't accumulate rework counts across turns.

**Roadmap:** escalation paths (human-in-loop queue, retry on a stronger model) are out of scope and noted in `docs/ROADMAP.md`.

### 7.5 Child workflow failure

A child workflow can fail when the Anthropic activity exhausts its retry budget, when an unexpected exception bubbles up, when an activity times out, etc.

**Orchestrator behavior:** catch `ChildWorkflowFailure`. Emit a `terminal_failure` event for the failed turn. Stay alive and ready for the next `userInput` signal.

**UI:** the `terminal_failure` event surfaces in the frontend as a "this turn failed" block with a retry affordance.

**Session-level `status: failed`:** reserved for orchestrator-level unrecoverability:

| Trigger | Session `status: failed`? |
|---|---|
| Single turn's Anthropic activity exhausts retries | No (per-turn `terminal_failure` only) |
| Orchestrator workflow throws an unhandled exception | Yes |
| Worker fleet unavailable so Temporal can't schedule the orchestrator | Yes (observable via session being stuck without progress; `stalledSinceMs` grows) |
| Reviewer rework cap hit | No (handled by `reviewerOverruled` flag, turn still completes successfully) |
| HMAC secret misconfig causes all webhooks to 401 | No at session level (turn still completes; user just sees no progress events; alerting / logs catch this) |

**Rationale:** the 5 mobile-pinned session statuses are session-lifecycle states. A failed turn is a per-turn outcome. Conflating them would break the mobile contract.

### 7.6 Orchestrator restart mid-turn

Worker process restarts (deploy, OOM, crash) while a turn is in flight. Temporal replays the workflow's history on a new worker.

**Mechanics:**

- Completed activities are pulled from history → not re-executed → no duplicate webhook calls.
- In-flight activities at the crash time are re-dispatched per their retry policy → webhook may be re-sent → handled by per-session dedupe.
- Signals sent during the restart window are buffered by Temporal and delivered when the workflow resumes, in order.

**UI behavior:**

- Restart gap is invisible. The UI saw whatever progress events arrived before the worker died.
- `stalledSinceMs` grows during the gap; frontend can show "still working…" once it exceeds a threshold.
- When the worker recovers and the activity is retried, the original `eventId` is re-used because it was generated inside the workflow with `workflow.uuid4()`. Per-session dedupe drops the duplicate.

**Critical implementation detail:** `eventId` MUST be generated in workflow code via `workflow.uuid4()`, NOT inside the activity via `crypto.randomUUID()` or similar. Activity-generated UUIDs are different on each retry, which would defeat dedupe. The workflow generates the id once and passes it to the activity; both the original attempt and the retried attempt use the same id.

**Dual-process restart (worker AND tb-streamer):** the failure window where the dedupe map is empty when the retried event arrives. One duplicate UI block per affected event. This is the accepted cost of option B — see `docs/plans/postgres-dedupe.md` for the option D upgrade path.

---

## 8. Testing strategy

This section names the test surfaces; specific test bodies live in the implementation plan.

| Surface | Coverage |
|---|---|
| Workflow unit tests | Each workflow runs against Temporal's test environment. Verify: stage sequence on happy path, stage sequence with 1 rework, stage sequence at cap with `reworkAttempt: 2` and `reviewerOverruled: true`, signal-serialization (two signals → two child workflows in order), child failure handled gracefully. |
| Activity unit tests | `sendProgressEvent` retries on 5xx, gives up after the configured attempt cap, never throws. HMAC signing produces a stable hex. |
| Webhook receiver tests (tb-streamer side) | Reject bad signature, accept good signature, dedupe by `eventId`, forward to ws-hub. |
| Integration smoke (manual or scripted) | Start one orchestrator session, send 2 user inputs back-to-back, verify second is queued + processed in order; verify all stage_transition events arrive in the WebSocket. |
| Dev local | Reuse the existing `temporal server start-dev` setup. No new infra. |

---

## 9. Configuration & secrets

| Variable | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | tb-multi-agent worker | LLM calls. Loaded via `src/shared/load-env.ts` with `override: true` (existing). |
| `PROGRESS_HMAC_SECRET` | Both processes | Shared secret for webhook signing/verifying. Same value in both `.env`s. |
| `PROGRESS_WEBHOOK_URL` | tb-multi-agent worker | Base URL for tb-streamer's webhook endpoint. e.g. `http://localhost:3456/internal/sessions`. |
| `MULTI_AGENT_FLOW` | tb-streamer | When `true`, tb-streamer runs in multi-agent mode (PTY unreachable). Also exposed as `--multi-agent-flow` flag. |
| `TEMPORAL_ADDRESS` | Both | Temporal server gRPC. Default `localhost:7233` for dev. |
| `TEMPORAL_TASK_QUEUE` | Both | Default `agent-tasks`. |

---

## 10. Risks and open questions

| Risk | Mitigation |
|---|---|
| Final webhook lost → JSONL not written → user sees no answer | Workflow result is still queryable via Temporal; reconcile path can pull it. Documented in §6.3. If this becomes a real concern, invert: worker writes JSONL via an activity, tb-streamer ingests via existing watcher. |
| Mobile clients interpret `status: failed` as "session is dead" | Resolution 1 in §7.5 reserves `status: failed` for orchestrator-level only. Verify against tb-streamer's CLAUDE.md / mobile contract during implementation; if the existing semantic is broader, narrow the scope inline in the plan. |
| Signal payload size grows unbounded as `conversationHistory` accumulates | Out of scope for B. Roadmap entry covers workflow-state promotion to compact summary + recent-turn buffer. For B, tb-streamer can window the snapshot if needed (e.g. last N turns). |
| `workflow.uuid4()` not used → dedupe silently broken | Surfaced as a critical implementation detail in §7.6 and called out again in the implementation plan. |
| Two streamers running side-by-side (PTY + multi-agent) → port conflict | Out of scope to solve in milestone B. Operator instruction: pass different `--port` to each. |

---

## 11. Implementation order (suggested)

This is a sketch, not the plan. The actual ordering lives in the writing-plans output.

1. Create the `@threadbase/agent-types` package with the wire shapes.
2. Wire it into both repos as a `file:` dep.
3. Refactor existing `taskPipelineWorkflow` → `turn.ts` child workflow. Add rework counter + `reviewerOverruled` flag.
4. Build `orchestratorWorkflow` with signal queue + serialization.
5. Build `sendProgressEvent` activity with HMAC + short retry window.
6. Wire progress events into the workflow at every stage transition + every agent_output.
7. tb-streamer side: webhook receiver, dedupe map, ws-hub forwarding.
8. tb-streamer side: agent-client wrapper (start workflow, signal).
9. tb-streamer side: `--multi-agent-flow` flag.
10. tb-streamer side: JSONL write on final agent_output.
11. Integration smoke test: end-to-end on localhost with `temporal server start-dev`.

---

## 12. References

- `signed-http-webhook-guide.md` (repo root) — full transport design for the webhook side-channel.
- `docs/plans/postgres-dedupe.md` — deferred option D upgrade for dedupe.
- `docs/ROADMAP.md` — full list of items deferred out of milestone B.
- `docs/threadbase-agent-orchestration.md` — original architecture brief.
- `docs/KICKOFF.md` — milestone B kickoff.
- tb-streamer `CLAUDE.md` — integration target: WebSocket hub, session vocabulary, mobile API surface.
