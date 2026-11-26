# M4 human gates — the phone signs off each answer

**Shipped:** 2026-11-26
**PR:** [#18 — feat(threadbase): ask the phone to sign off each answer](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/18)

## What shipped

A pipeline gate can now wait for a person.
A gate phase with options opens a card, waits for an answer or a timeout, and acts on the chosen option: continue, send the agent back to rework, or stop.
The Threadbase sign-off is the first such gate, with Approve, Request changes and Stop, so the answer reaches the conversation only after someone releases it from the phone.
The wire contract grows by two events and one signal, shipped as `@threadbase-sh/agent-types` 1.1.0; the streamer half turns them into the permission card mobile already shows.

## Why it matters

- **Nothing reaches the conversation unseen.** Sign-off used to pass whenever the reviewer approved; now a person decides.
- **"Not quite" no longer means starting over.** Request changes sends the draft back to the worker inside the same turn, and the turn asks again.
- **A stopped turn still ends cleanly.** Stop finishes the turn at `done` with a fixed message, so the session lock is released and the next prompt can run.

## Architecture

- **Engine** (`src/engine/run.ts`, `src/engine/pipeline.ts`) — a gate phase may carry `prompt`, `detail`, `options` (`continue` / `rework` / `stop`), `timeout` and `onTimeout`. `GateInbox` holds the one open gate and drops an answer for any other gate id, an out-of-range option, or a second answer. Each ask gets a new id, so a late answer to an earlier card cannot close the current one. The engine emits `gate_open` and `gate_closed`, and `finished` carries `stopped`. A gate without options keeps calling `io.gate()`, as before.
- **`pipelineWorkflow`** (`src/threadbase/pipeline.ts`) — sign-off is a gate with three options, a 12-hour timeout and Approve on timeout. A `gateAnswer` signal handler feeds the inbox. Turns that started before this change keep the automatic sign-off under the `human-sign-off` patch.
- **`toProgress`** (`src/threadbase/stages.ts`) — maps the engine's gate events to the wire events at stage `sign-off`, and replaces a stopped turn's content with "Stopped at sign-off. The answer was not released."
- **Wire contract** — additive, in `@threadbase-sh/agent-types` 1.1.0: progress events `gate_open` (`{ gateId, prompt, detail?, options }`) and `gate_closed` (`{ gateId, optionIndex, timedOut }`), and `GateAnswerSignal` (`{ gateId, optionIndex }`). The signal is named `gateAnswer` and goes to the turn's child workflow, `turn-<turnId>`, not to the session workflow.

## User-visible behavior

- After review, the turn emits `gate_open` at stage `sign-off` and waits.
- Approve releases the draft as the final `agent_output` at `done`, as before.
- Request changes emits `rework`, reruns the worker with "Request changes" as its notes, reviews again and opens a new card.
- Stop ends the turn at `done` with the stopped message instead of the draft.
- No answer within 12 hours approves, and `gate_closed` says `timedOut: true`.

## Operator-facing details

- **Run command:** unchanged, `npm run worker`.
- **Required env:** unchanged.
- **Optional env:** none.
- **Logging:** a dropped answer logs `gate answer dropped` with its `gateId`.
- **Deploy order:** deploy the streamer that handles `gate_open` first. An older streamer accepts the new events and ignores them, so no turn fails, but no card reaches the phone and every turn waits the full 12 hours before it approves.

## Tests

- **Engine** — `test/engine/gate.test.ts`: answer, timeout to `onTimeout`, a stale gate id dropped, rework asking again under a new id, Stop, and exactly one `finished` per run.
- **Workflow** — `test/threadbase/sign-off-gate.test.ts`: the card's payload, Approve, Request changes, Stop, the 12-hour timeout measured on the workflow clock, and a stale answer.
- **Replay** — a `pipelineWorkflow` history recorded from the automatic sign-off code replays under the patch (`test/fixtures/pipeline-auto-sign-off-history.json`).
- **Existing suites** — the workflow and integration stubs answer every gate Approve, as the phone would; the parity test compares everything but sign-off. `npm test` runs 23 files / 145 tests.
- **Mutant check** — 25 mutants on the changed lines, all killed.

## Breaking changes

**None.** The new events and signal are additive, and turns in flight keep the old sign-off.

## Deferred

- Rework from a gate has no cap; a person keeps choosing it, so the loop ends when they stop.
- The card shows no draft (`detail` is unset); mobile shows the draft from the processing stage's `agent_output`.
- The timeout and its option are code, not config.

## Related work in tb-streamer

- The streamer maps `gate_open` to the `permission` WS event (content key = gate id), sets the session to `waiting_input`, maps `gate_closed` to `permission_cancelled`, and signals `gateAnswer` when the phone answers.
