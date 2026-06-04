# Roadmap

Things deferred out of the current milestone, kept here so we can find them again.

## Architecture upgrades

- **LLM-as-orchestrator.** Today the orchestrator workflow is a hard-coded pipeline. Promote it to an LLM that picks sub-agent activities dynamically. Pre-requisite for non-trivial routing decisions across stages.
- **`continueAsNew` in the long-lived orchestrator.** Required before any session can exceed roughly 25 turns in production — Temporal histories grow linearly, and the orchestrator workflow has to checkpoint via `continueAsNew` to stay healthy.
- **Workflow state promotion (B.1 → B/C hybrid).** Milestone B keeps no `conversationHistory` in workflow state — history rides in each signal payload, composed by tb-streamer from its cache. Once LLM-as-orchestrator needs real cross-turn reasoning, promote to a compact summary + recent-turn buffer held by the workflow.
- **`@threadbase/agent-types` package promotion.**
  - ~~**Stage 1:** local `file:` dep with source at `tb-multi-agent/packages/agent-types/`, tb-streamer consuming via symlink.~~ Retired 2026-06-04 — the symlink approach broke CI and forced cross-repo discipline that wasn't viable.
  - **Stage 2 (current, 2026-06-04):** standalone public repo at [RonenMars/threadbase-agent-types](https://github.com/RonenMars/threadbase-agent-types). Both consumers pin via git submodule (`packages/agent-types/` in tb-multi-agent, `vendor/agent-types/` in tb-streamer), currently at SHA `f8bfe43`. Both repos' CIs use `submodules: recursive`. Bumping the wire contract is a deliberate three-step act: push to agent-types repo → `git submodule update --remote` in the consuming repo → commit the SHA bump. Execution plan: [`docs/superpowers/plans/2026-06-03-stage-2-agent-types-extraction.md`](superpowers/plans/2026-06-03-stage-2-agent-types-extraction.md).
  - **Stage 3 (planned):** published npm package. Real package boundary, versioned contract, no submodule SHA-bump dance. Bundle this with the tb-streamer distribution refactor ([`docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md`](superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md)) — same npm-scope decisions, same publishing pipeline, same release cadence. Prerequisite: claim the `@threadbase` npm scope (currently unclaimed).

## Reliability upgrades

- **Rework escalation path.** Milestone B caps rework at 2 and emits the last draft with a `reviewerOverruled` flag. Future work: escalate hitting the cap to a human-in-loop review queue, or auto-retry on a stronger model. Decision deferred until we see how often the cap is actually hit in real traffic.
- **Postgres-backed progress event dedupe (option D).** Milestone B uses an in-memory per-session dedupe map on tb-streamer (option B). Upgrade to a Postgres unique-index table when duplicate UI blocks during restarts stop being acceptable, when tb-streamer needs more than one replica per session, or when auditing live delivery becomes a requirement. Full design: [`docs/plans/postgres-dedupe.md`](plans/postgres-dedupe.md).

## Distribution

- **tb-streamer npm publish.** Milestone B integration tests consume tb-streamer via a local `file:../tb-streamer` dep because GitHub-URL installs fail (submodule + native-build chain) and tb-streamer doesn't publish to npm. Path forward: extract `@threadbase/streamer-api` as a workspace package and publish it (Scope B in the spec) — agent surface only, no node-pty/SQLite/CLI deps. Removes the sibling-checkout requirement for integration tests and unlocks external integrators. Full scope analysis and recommended approach: [`docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md`](superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md).

## API hygiene

- **Structured error codes retrofit.** Plan 3.5 introduces structured `{error, code}` responses for multi-agent endpoints. Existing PTY-mode endpoints in tb-streamer's `server.ts` still return unstructured `{error: "human msg"}` only. Retrofit them when (a) the mobile app needs distinguishable error handling on PTY paths, (b) a second non-mobile consumer wants typed errors, or (c) the unstructured pattern has caused a real bug. Full design: [`docs/plans/structured-error-codes-retrofit.md`](plans/structured-error-codes-retrofit.md). Estimated effort: 1-2 days focused work.
