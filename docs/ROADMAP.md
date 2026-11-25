# Roadmap

What is planned next, in order, and what is deferred with the signal that would bring it back.
Each milestone keeps the wire contract the streamer relies on: `orchestratorWorkflow`, `session-<id>`, the `agent-tasks` queue, the `userInput` signal, the `stage` query, and the existing event types and stages.

## Shipped

- **Milestone B (2026-06-04):** the multi-agent worker, with the session orchestrator, a worker → reviewer → sign-off turn and signed progress webhooks ([#1](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/1), notes in [`release-notes/2026-06-04-milestone-b.md`](release-notes/2026-06-04-milestone-b.md)).
- **M0 (2026-11-25):** progress delivery to the streamer works again ([#13](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/13)).
  The streamer now comes from npm as `@threadbase-sh/streamer`, so the integration scenarios run in CI without a sibling checkout.
  The streamer cancels `session-<id>` when a multi-agent session is stopped or killed.
- **M1 (2026-11-25):** turns run on a product-agnostic engine in `src/engine/`, through the new `pipelineWorkflow` child ([#14](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/14), notes in [`release-notes/2026-11-25-engine-extract.md`](release-notes/2026-11-25-engine-extract.md)).

## Next

### M2: `continueAsNew` for long sessions

- The orchestrator continues as new after a number of turns, or once its history length passes a threshold, carrying the pending queue and its counters.
  Temporal histories grow with every turn, so a long session needs this to stay healthy.
- Ids, signals and queries keep their names, so the streamer does not notice.
- A 30-turn time-skipping test must not drop a queued input.

### M3: runtime seam and roles

- An `AgentRuntime` interface, with today's text agent as its first runtime.
- A Claude Agent SDK runtime that works inside the session's project directory, with a tool allowlist, a per-agent budget and its cost reported back.
- A secret guard inside SDK sessions: reads of `.env*`, `~/.ssh`, credential files and the streamer's config are refused, and secrets are masked in debug logs.
- Roles as data in `roles.yaml` (model, runtime, tools, effort and prompt), keyed by any string; the worker and reviewer default to the text runtime.
- An additive start argument, `orchestratorWorkflow(sessionId, opts?: { projectPath?: string })`, passed by the streamer.

### M4: durable human gates on the phone

- A `gate` phase waits for an answer with a timeout, takes its `onTimeout` option when none comes, and drops answers with a stale or unknown `gateId`.
- An additive agent-types release adds `gate_open` and `gate_closed` events.
- The streamer maps them onto its existing WS `permission` and `permission_cancelled` events and signals `gateAnswer` back, so the phone needs no change.
- Sign-off becomes a real gate: Approve, Request changes (back to rework) or Stop.
- Every turn still ends with `agent_output` at `done` or with `terminal_failure`, so the streamer's turn lock always releases.

### M5: spend cap and rework escalation

- A per-turn spend cap over the runtimes' reported cost; reaching it ends the turn with `terminal_failure` and a reason.
- Reaching the rework cap opens a gate (accept anyway, retry on a stronger model, or stop) instead of sending the last draft with `reviewerOverruled`.

### M6: CI hardening

- A diff-driven skip gate with a paths file, replacing the `[skip-ci]` text tag.
- gitleaks over the change's commits, and `npm audit --omit=dev`.
- Actions pinned by SHA, `permissions: contents: read`, and concurrency groups.

## Deferred

- **LLM-as-orchestrator.** The pipeline is a fixed list of phases. An LLM that picks the next phase comes once the static pipeline is proven in real traffic.
- **Workflow state promotion.** The workflow keeps no conversation history; it rides in each `userInput` payload, composed by the streamer. Once cross-turn reasoning needs it, hold a compact summary plus a recent-turn buffer in the workflow.
- **Review memory (lessons and precedents).** Once gates produce decisions worth reusing.
- **Batches.** If the phone gets a batch UI.
- **Postgres-backed progress event dedupe.** The streamer dedupes progress events in memory per session. Move to a Postgres unique-index table when duplicate UI blocks during restarts stop being acceptable, when the streamer needs more than one replica per session, or when live delivery needs an audit trail. Design: [`plans/postgres-dedupe.md`](plans/postgres-dedupe.md).
- **Structured error codes on the streamer's PTY endpoints.** Multi-agent endpoints return `{error, code}`; the older PTY endpoints return only `{error}`. Retrofit them when the mobile app needs to tell PTY errors apart, a second consumer wants typed errors, or the untyped shape causes a real bug. Design: [`plans/structured-error-codes-retrofit.md`](plans/structured-error-codes-retrofit.md).

## Known gap

The mobile app does not yet render `agent_output`, `terminal_failure` or stage events; answers reach the phone only through the conversation JSONL.

## The wire types

`@threadbase-sh/agent-types` lives in [threadbase-agent-types](https://github.com/RonenMars/threadbase-agent-types) and is published on npm.
This repo checks it out as a git submodule at `packages/agent-types`, pinned to a release tag (`v1.0.0` today), and each agent-types release opens a PR here that bumps it (`.github/workflows/update-agent-types.yml`).
