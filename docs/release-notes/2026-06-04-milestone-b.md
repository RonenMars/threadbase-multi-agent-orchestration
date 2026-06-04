# Milestone B — Multi-agent orchestration worker

**Shipped:** 2026-06-04
**PR:** [#1 — milestone b multi-agent orchestration](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/1)
**Squash commit on main:** `93ee8c0`

## What shipped

The first end-to-end implementation of the Threadbase multi-agent worker. A Temporal-based process that consumes signals from tb-streamer (when run in `MULTI_AGENT_FLOW=true` mode), drives a worker → reviewer → sign-off pipeline against an Anthropic model, and reports progress back via HMAC-signed webhooks.

This repo and tb-streamer are designed to be deployable independently. The wire contract between them is the `@threadbase/agent-types` package (consumed as a git submodule from both sides) and the shared `PROGRESS_HMAC_SECRET`.

## Why it matters

PTY mode in tb-streamer was a single agent talking to a terminal. The multi-agent worker introduces:

- **Per-turn stage transitions** the mobile app can react to (`queued`, `processing`, `review`, `sign-off`, `done`).
- **Reviewer LLM** that critiques the worker's draft and can request rework — surfacing `reviewerOverruled` in the WebSocket event.
- **Durable execution** via Temporal: if the worker crashes mid-turn, Temporal resumes the workflow from its last checkpoint. The streamer's `currentTurnId` lock is the same in either case.
- **Provider independence** — the worker can swap Anthropic for any other model without touching the streamer, the mobile app, or the wire format.

## Architecture

Two workflow types:

- **`orchestratorWorkflow`** — long-lived, one per session. Receives `userInput` signals, dispatches `turnWorkflow` children, manages a queue of pending turns, releases the session lock when each turn completes.
- **`turnWorkflow`** — one-shot, one per user message. Calls `processTask` (worker LLM) → `reviewTask` (reviewer LLM) → optionally loops on rework → emits `done`. Each transition fires `sendProgressEvent` activity that POSTs an HMAC-signed event to tb-streamer.

Activities:

- **`processTask`** — single Anthropic API call with the conversation history the streamer composed. Returns the draft.
- **`reviewTask`** — single Anthropic call against the reviewer prompt + the draft. Returns `{approved, notes}`.
- **`sendProgressEvent`** — fire-and-forget HMAC-signed webhook. Best-effort: 3 attempts with short backoff. Never throws — webhook failure does not fail the surrounding activity.

## User-visible behavior

Mobile clients never talk to this worker directly. The user-visible behavior of the worker is exactly the WebSocket message stream the streamer broadcasts:

- `session_update` with `stage: "queued" | "processing" | "review" | "sign-off" | "done"` and `turnId`.
- `agent_output` with `role: "worker" | "reviewer" | "signoff"`, `content`, and optional `reviewerOverruled` and `reworkAttempt`.
- `turn_failure` with `reason` on terminal failure.

## Operator-facing details

- **`npm run worker`** — runs `tsx watch src/worker.ts`, polls the `agent-tasks` Temporal task queue.
- **Required env:** `ANTHROPIC_API_KEY`, `PROGRESS_HMAC_SECRET` (must match the streamer), `PROGRESS_WEBHOOK_URL` (default `http://localhost:3456/internal/sessions` — set to your streamer's URL).
- **Optional env:** `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `AGENT_MODEL` (defaults to `claude-opus-4-7`).
- **Logging** uses pino. Inside an activity, `Context.current().log` is the Temporal-context logger (so activity logs get the workflow metadata); outside (e.g., bootstrap), the root pino logger is used.

## Tests

- **Unit + workflow tests** via vitest + `@temporalio/testing` — exercise the orchestrator's queue, the turn pipeline, the reviewer-overrule path, the dedupe semantics on the receiver side.
- **Integration tests** — 12 cross-repo scenarios driving the full streamer-worker pipeline against a real Temporal dev server.
- **End-to-end smoke** — separate runbook in tb-streamer's `docs/superpowers/specs/`. Final pre-merge smoke (2026-06-04) was green: all 10 progress webhooks returned 200, JSONL was written, Anthropic returned a TypeScript debounce function.

## Breaking changes

**None.** This is a new repo shipping its initial release. tb-streamer's PTY mode is unaffected.

## Deferred to Milestone C

The Plan 3.5 brainstorm verified-by-Temporal-docs that the current "full conversation history in every `UserInputSignal`" approach has hard ceilings: 2 MB single payload, 4 MB Event History transaction, 50 MB total workflow history. The streamer ships a fail-fast guard (`SESSION_HISTORY_FULL` → 413) so long conversations break in a structured, recoverable way. Milestone C will redesign the contract toward deltas-only signals with workflow-held conversation state.

See `docs/ROADMAP.md` for the broader sequencing.

## Related work in tb-streamer

- [`threadbase-streamer` PR #17 — multi-agent mode wiring](https://github.com/RonenMars/threadbase-streamer/pull/17)
- [`threadbase-streamer` PR #18 — Plan 3.5 HTTP endpoints](https://github.com/RonenMars/threadbase-streamer/pull/18)

The streamer's release notes for the same milestone are at `threadbase-streamer/docs/release-notes/2026-06-04-milestone-b.md`.
