# Roadmap

Things deferred out of the current milestone, kept here so we can find them again.

## Architecture upgrades

- **LLM-as-orchestrator.** Today the orchestrator workflow is a hard-coded pipeline. Promote it to an LLM that picks sub-agent activities dynamically. Pre-requisite for non-trivial routing decisions across stages.
- **`continueAsNew` in the long-lived orchestrator.** Required before any session can exceed roughly 25 turns in production — Temporal histories grow linearly, and the orchestrator workflow has to checkpoint via `continueAsNew` to stay healthy.
- **Workflow state promotion (B.1 → B/C hybrid).** Milestone B keeps no `conversationHistory` in workflow state — history rides in each signal payload, composed by tb-streamer from its cache. Once LLM-as-orchestrator needs real cross-turn reasoning, promote to a compact summary + recent-turn buffer held by the workflow.
- **`@threadbase/agent-types` package promotion.**
  - Stage 1 (current, milestone B): local `file:` dep. Source of truth lives at `packages/agent-types/` inside tb-multi-agent's repo; tb-streamer consumes it via a symlink at `vendor/agent-types` pointing at `../../tb-multi-agent/packages/agent-types`. Implication: both repos must be checked out as siblings, and tb-streamer's built `dist/` reflects whatever was in tb-multi-agent's checkout at build time.
  - Known discipline gap (Stage 1): tb-streamer's committed `dist/` can silently drift from tb-multi-agent's agent-types source if tb-streamer is pushed without a fresh rebuild against the current agent-types HEAD. Mitigation today is workflow discipline: before pushing tb-streamer, rebuild against the matching tb-multi-agent commit. Scenarios #3 (CI) and #4 (external reviewer) are not affected today because there is no CI and no external reviewer; they will be once those exist.
  - Stage 2: public GitHub repo + git submodule (mirrors `vendor/scanner`). Fixes the symlink fragility and the discipline gap for sync, but does NOT fix the committed-`dist/` drift problem (only Stage 3 does). Probably not worth the ~3 hours of submodule plumbing as a standalone step if Stage 3 is the real destination.
  - Stage 3: published npm package. Real package boundary, versioned contract, no sibling-checkout requirement, no `dist/` drift (the registry holds the verified artifact). Bundle this with the tb-streamer distribution refactor (`docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md`) — same npm-scope decisions, same publishing pipeline, same release cadence.

## Reliability upgrades

- **Rework escalation path.** Milestone B caps rework at 2 and emits the last draft with a `reviewerOverruled` flag. Future work: escalate hitting the cap to a human-in-loop review queue, or auto-retry on a stronger model. Decision deferred until we see how often the cap is actually hit in real traffic.
- **Postgres-backed progress event dedupe (option D).** Milestone B uses an in-memory per-session dedupe map on tb-streamer (option B). Upgrade to a Postgres unique-index table when duplicate UI blocks during restarts stop being acceptable, when tb-streamer needs more than one replica per session, or when auditing live delivery becomes a requirement. Full design: [`docs/plans/postgres-dedupe.md`](plans/postgres-dedupe.md).

## Distribution

- **tb-streamer npm publish.** Milestone B integration tests consume tb-streamer via a local `file:../tb-streamer` dep because GitHub-URL installs fail (submodule + native-build chain) and tb-streamer doesn't publish to npm. Path forward: extract `@threadbase/streamer-api` as a workspace package and publish it (Scope B in the spec) — agent surface only, no node-pty/SQLite/CLI deps. Removes the sibling-checkout requirement for integration tests and unlocks external integrators. Full scope analysis and recommended approach: [`docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md`](superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md).
