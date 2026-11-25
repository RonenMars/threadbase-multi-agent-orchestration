# M2 continue-as-new — long sessions start a fresh history between turns

**Shipped:** 2026-11-25
**PR:** [#16 — feat: continue long sessions as new between turns](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/16)

## What shipped

`orchestratorWorkflow` now continues as new once a run has handled 20 turns, or once its history passes 500 events, whichever comes first.
The new run starts with the inputs that were still queued, so nothing the user sent is lost, and those inputs do not get a second `queued` event.
The switch happens only between turns, after any `userInput` handler has finished sending its `queued` event.
Nothing changes on the wire: the streamer finds the session by its workflow id alone, so its signals, queries and cancels reach the new run without any change on its side.

## Why it matters

- **Long sessions stay healthy.** Every turn adds about 13 events to the session's history, and Temporal warns about, then terminates, a workflow whose history grows past its limits. A session can now run for as many turns as the user wants.
- **A flood of messages cannot blow up a single run.** The event limit catches the case the turn limit misses: many inputs piling up behind one slow turn.
- **Deploys stay safe for running sessions.** The check sits behind its own `patched('continue-as-new')` marker, and a replay of a 25-turn session recorded on the previous code proves a session that was already past the turn limit replays without a non-determinism error.

## Architecture

- **`orchestratorWorkflow`** (`src/threadbase/orchestrator.ts`) — takes an optional second argument, `{ queue }`, which only continue-as-new sets. At the top of each loop it checks the two limits, waits for `allHandlersFinished`, then calls `continueAsNew(sessionId, { queue })`.
- **Limits** — `MAX_TURNS_PER_RUN = 20` and `MAX_HISTORY_EVENTS = 500`, as constants in the workflow.
- **Wire contract** — unchanged. The workflow id (`session-<id>`), the `agent-tasks` queue, the `userInput` signal, the `stage` and `queueDepth` queries and the `[sessionId]` start args keep their names and shapes.

## User-visible behavior

- None. Clients receive the same events in the same order; a turn waiting across the switch keeps its single `queued` event.
- In the Temporal UI, a long session shows as a chain of runs under the same workflow id, each ending in "continued as new".

## Operator-facing details

- **Run command:** unchanged, `npm run worker`.
- **Required env:** unchanged.
- **Optional env:** unchanged.
- **Logging:** a new `orchestrator continuing as new` line with `sessionId`, `turnsThisRun` and `queueDepth`.
- **Deploy order:** roll the new worker out everywhere first; a pre-M2 worker ignores the second argument, so a run it picks up after a switch would start with an empty queue.

## Tests

- **Continue-as-new** — `test/workflows/continue-as-new.test.ts`:
  - 30 inputs sent at once run across two runs of 20 and 10 turns, every turn reaches `done` in order with at most one `queued` event, and every run's history replays.
  - 120 inputs sent at once trip the event limit before the turn limit, and the next run carries every input not yet run.
  - A `userInput` handler still sending its `queued` event when turn 20 ends holds the switch until it finishes.
  - A 25-turn session recorded on the previous code (`test/fixtures/orchestrator-long-history.json`) replays.
- **Existing suites** — unchanged and passing: `npm test` runs 15 files / 54 tests.
- **Mutant check** — 9 mutants on the changed lines, all killed.

## Breaking changes

**None.**

## Deferred to M3

- M3's additive start option (`projectPath`) should join the same second-argument object, and the continue-as-new call must pass it on to the next run.
- The limits are constants; making them configurable waits until a session shows a need.
- See `docs/ROADMAP.md` for the broader sequencing.
