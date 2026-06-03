# @threadbase/agent-types

Shared wire types for the Threadbase multi-agent pipeline.

These types live on the boundary between two processes:

- `tb-multi-agent` — the Temporal worker that runs the orchestrator + turn workflows and the AI-agent activities.
- `tb-streamer` — the Temporal client that owns the WebSocket connection to the mobile frontend and writes JSONL.

Both processes import from this package so the wire shapes (progress events, signal payloads, session addendum, final-answer flags) stay in sync.

## Distribution status

Milestone B keeps this as a **local `file:` dependency**. Both consumers point their `package.json` at a relative path into this directory.

The roadmap promotes it to a git submodule (matching `vendor/scanner` in `tb-streamer`) and eventually to a published npm package. See `docs/ROADMAP.md` and `docs/superpowers/specs/2026-06-03-tb-multi-agent-mode-design.md` for context.
