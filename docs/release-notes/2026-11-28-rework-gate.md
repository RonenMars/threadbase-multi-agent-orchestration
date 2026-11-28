# M5 rework gate — a person decides when the reviewer keeps rejecting

**Shipped:** 2026-11-28
**PR:** [#20 — feat(threadbase): ask a human when the reviewer rejects at the rework cap](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/20)

## What shipped

When the reviewer still rejects an answer after 2 reworks, the turn now opens a card and asks what to do: Accept anyway, Retry on a stronger model, or Stop.
Before this change, the last draft went on to sign-off flagged as overruled.
This is the rework escalation half of M5; the per-turn spend cap is deferred.
The wire contract and the streamer need no change.

## Why it matters

- **A rejection now gets a decision.** A person sees the reviewer's notes and chooses, instead of being asked only to sign off a draft the reviewer had refused.
- **A stubborn task has a way forward.** One more attempt can run on a stronger model without starting the turn over.
- **Silence does not release a rejected answer.** An unanswered card stops the turn.

## Architecture

- **Engine** (`src/engine/run.ts`, `src/engine/pipeline.ts`) — a review phase may name an `exhausted` gate, asked while the verdict is still a rejection at the rework cap. A gate option may `release` the output, which skips later gates, or `escalate` the rework. Escalating options are dropped when `io.canEscalate` says no. `finished` and the result carry `stoppedAt`.
- **`pipelineWorkflow`** (`src/threadbase/pipeline.ts`) — the review phase uses the `rework-cap` gate, with the reviewer's notes as its detail. An escalated rework uses the longer activity timeout tier. Turns already running keep the old path under the `rework-gate` patch.
- **`escalationAvailable`** — a new local activity that says whether a role names an escalation model. Role lookup local activities now stop after 3 attempts, so a failing lookup ends the turn instead of retrying for ever.
- **Text runtime** (`src/runtimes/text.ts`) — a role with an `effort` streams with `max_tokens` 64000, and fails on a refused, empty or cut-off answer.
- **Wire contract** — unchanged. The card reuses `gate_open` and `gate_closed` at the existing stage `review`.

## User-visible behavior

- After the second rejected rework, the turn emits `gate_open` at stage `review` and waits.
- **Accept anyway** ends the turn at `done` with the draft, flagged `reviewerOverruled`, with no sign-off card.
- **Retry on a stronger model** reworks once on the escalation model and reviews again. An approval goes on to sign-off; another rejection asks again.
- **Stop** ends the turn at `done` with "Stopped at review. The answer was not released."
- No answer within 12 hours stops the turn, and `gate_closed` says `timedOut: true`.
- If the worker role names no escalation model, the card offers only Accept anyway and Stop.

## Operator-facing details

- **Run command:** unchanged, `npm run worker`.
- **Required env:** unchanged.
- **Roles:** `roles.yaml` takes `escalationModel` and `escalationEffort`; `effort` now applies to text roles too. As shipped, the worker escalates to `claude-opus-5-5` at `xhigh`.
- **Deploy order:** the streamer must be one that handles `gate_open` (threadbase-streamer #1331). With an older one no card reaches the phone, and a rejected turn waits 12 hours and then stops.

## Tests

- **Engine, workflow and runtime** — `test/engine/rework-cap-gate.test.ts`, `test/threadbase/rework-gate.test.ts` and `test/runtimes/escalation.test.ts` cover each answer, the timeout, and a failing activity ending the turn in one `terminal_failure`.
- **Replay** — a history recorded before this change replays under the patch (`test/fixtures/pipeline-overruled-history.json`).
- **Suite** — `npm test` passes 172 tests in 26 files.
- **Mutant check** — 19 mutants on the changed lines, all killed.
- **End-to-end smoke** — not run. The new card has not been seen on a phone, and no real call has been made to the escalation model.

## Breaking changes

**None.** One behavior change: a turn the reviewer still rejects now waits for an answer, and stops if none arrives, where it used to continue to sign-off.

## Deferred

- **Per-turn spend cap.** The text runtime reports no cost yet, so it needs pricing first. Until then, retries are bounded only by each needing a human answer. See [`docs/ROADMAP.md`](../ROADMAP.md).
- **Server-side refusal fallbacks** for text roles are not enabled.
