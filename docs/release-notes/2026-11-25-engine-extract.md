# M1 engine extract — turns run on a product-agnostic engine

**Shipped:** 2026-11-25
**PR:** [#14 — refactor: run turns through an engine pipeline child workflow](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/14)

## What shipped

The worker → reviewer → rework → sign-off loop moved out of `turnWorkflow` into a small engine in `src/engine/`, which knows phases (agent, review with rework, gate) and nothing about Threadbase.
A new child workflow, `pipelineWorkflow`, runs Threadbase's phase list on that engine and maps its events onto the same agent-types progress events the streamer already reads.
The orchestrator starts `pipelineWorkflow` for every new turn, while sessions that began on the previous code keep replaying their turns as `turnWorkflow`.
Nothing changes on the wire: the streamer, the mobile app and `@threadbase-sh/agent-types` see the same stages, events and ids.

## Why it matters

- **The pipeline becomes data.** A turn is now a list of phases, so later milestones can change the phases (another reviewer, a real sign-off gate) without rewriting the workflow's control flow.
- **The engine can be tested and reused on its own.** `runPipeline` takes its side effects as arguments, so its loop is checked without Temporal, and nothing in it is tied to this product.
- **Deploys stay safe for running sessions.** The switch sits behind one `patched('pipeline-child')` marker, and a replay test over a history recorded from the previous code proves a session that was already running replays without a non-determinism error.

## Architecture

- **`src/engine/`** — `pipeline.ts` holds the phase, event and IO types; `run.ts` holds `runPipeline(spec, io)`, the deterministic loop (agent, review with up to `maxRework` reworks, gate).
- **`pipelineWorkflow`** (`src/threadbase/pipeline.ts`) — one-shot, one per turn. Declares the phases (worker, reviewer with 2 reworks, sign-off) and binds them to the existing `processTask`, `reviewTask`, `productSignOff` and `sendProgressEvent` activities with the same timeouts and retries.
- **`src/threadbase/stages.ts`** — maps engine events onto `stage_transition` and `agent_output` events.
- **`orchestratorWorkflow`** — moved to `src/threadbase/` with `signals.ts` and `progress.ts`; it now picks `pipelineWorkflow` for new turns under `patched('pipeline-child')`.
- **`turnWorkflow`** — frozen in `src/workflows/turn.ts` so turns started before the switch can finish; it can be deleted once none can still be running.
- **Wire contract** — unchanged. Workflow ids (`session-<id>`, `turn-<id>`), the `agent-tasks` queue, the `userInput` signal and the `stage` and `queueDepth` queries keep their names.

## User-visible behavior

- None. Clients receive the same events in the same order, with the same `seq`, `stage`, `reworkAttempt` and `reviewerOverruled` fields.
- In the Temporal UI, new turns show the workflow type `pipelineWorkflow` instead of `turnWorkflow`.

## Operator-facing details

- **Run command:** unchanged, `npm run worker`.
- **Required env:** unchanged.
- **Optional env:** unchanged.
- **Logging:** the same log lines (`turn started`, `stage transition`, `progress event emitted`, `turn completed`) with the same fields.
- **Deploy order:** roll the new worker out everywhere before relying on it; a pre-M1 worker cannot run a `pipelineWorkflow` task.

## Tests

- **Replay** — `test/workflows/replay.test.ts` replays an orchestrator session and a turn recorded from the previous code (`test/fixtures/`), and checks that a session started on this code runs its turns as `pipelineWorkflow` and replays.
- **Parity** — `test/threadbase/parity.test.ts` runs `turnWorkflow` and `pipelineWorkflow` side by side over 0 to 3 reviewer rejections, with and without history, and requires identical events, activity arguments and results.
- **Engine** — `test/engine/run.test.ts` covers the engine's edge cases and greps `src/engine/` for product words.
- **Existing suites** — `test/workflows/turn.test.ts` now runs against `pipelineWorkflow`; it and `orchestrator.test.ts` changed only in their imports. The integration scenarios pass unchanged.

## Breaking changes

**None.**

## Deferred to M2

- Sign-off is still a pass-through; a real gate is later work.
- `turnWorkflow` and the `patched('pipeline-child')` branch stay until no pre-M1 turn can still be running.
- See `docs/ROADMAP.md` for the broader sequencing (it predates this milestone and needs a refresh).
