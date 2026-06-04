# threadbase-orchestration vs. Claude Code dynamic workflows

A reference for anyone wondering whether [Claude Code dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) could replace — or complement — this Temporal-based orchestration service.

**Short answer:** they solve different problems. Dynamic workflows are an *interactive*, *session-scoped* fan-out tool for ad-hoc analysis inside Claude Code. This service is a *durable*, *production* pipeline that ingests messages from the Threadbase backend and runs them through a worker → reviewer → sign-off chain that survives crashes and retries on its own.

## What "Claude Code dynamic workflows" actually are

A runtime feature inside an interactive Claude Code session. When triggered (explicitly, or automatically via the `ultracode` setting at effort `xhigh`), Claude writes throwaway orchestration scripts that fan out tens to hundreds of parallel subagents in a single session, with verification loops, adversarial cross-checking, progress checkpointing, and iterative convergence.

The blog post calls out three canonical use cases:

- **Codebase audits** — bug hunts, security audits, profiler-guided optimization across an entire service.
- **Large-scale migrations** — framework swaps, API deprecations, language ports spanning thousands of files.
- **Critical review work** — independent parallel attempts with adversarial testing before delivery.

It also calls out the cost: substantially more tokens than a normal session, confirmation required before first execution, and the recommendation to start scoped.

## What threadbase-orchestration is

A Temporal-backed pipeline. The Threadbase backend calls `startTask(...)` from `src/client.ts` per inbound message; that enqueues a workflow which runs deterministic orchestration in `src/workflows.ts` and dispatches LLM work to activities in `src/activities.ts`. Workers (`src/worker.ts`) consume the `agent-tasks` queue; scale = run more workers. Temporal records every step so the pipeline survives crashes, retries activities per policy, and can be queried for stage or final result.

## Full comparison

| Dimension | Claude Code dynamic workflows | threadbase-orchestration |
|---|---|---|
| **Primary purpose** | Ad-hoc deep analysis / migration inside one Claude Code session | Production message pipeline for Threadbase |
| **Trigger** | Human in an interactive CLI session (or `ultracode` auto-decide) | HTTP request from the Threadbase backend → `startTask(...)` |
| **Concurrency model** | Dozens-to-hundreds of subagents in one session, orchestrated by Claude-written scripts | One workflow per task; horizontal scale by adding workers on the `agent-tasks` queue |
| **State durability** | Session-scoped; checkpoint/resume *within* a job, not after Claude exits | Full event-sourced history in Temporal; workflow survives worker/host crashes |
| **Retry policy** | Internal verification loops; not a per-step retry policy you configure | Per-activity `retryPolicy` declared in `workflows.ts`, executed by Temporal |
| **Determinism guarantee** | None — the orchestration script is generated at runtime | Workflow code is deterministic by contract; non-determinism only in activities |
| **Observability** | Claude's session UI; logs are session-scoped | Temporal Web UI at `localhost:8080` (or Temporal Cloud); per-task history, replay |
| **Backpressure / queueing** | None — it's one session | Task queue with workers; backpressure is "more pending tasks" |
| **Latency profile** | Minutes-to-hours per workflow, optimized for thoroughness | Sub-second to start; activity latency dominated by LLM round-trips |
| **Failure model** | If the session dies, the job dies (with whatever was checkpointed) | Activity failure → retried; worker crash → another worker resumes; workflow can run for days |
| **Cost profile** | "Substantially more tokens than standard sessions" per the blog | One LLM call per agent stage per task; predictable per-message |
| **Who calls it** | A developer at the keyboard | The Threadbase backend, programmatically |
| **Auditability** | Conversation transcript | Temporal event history (append-only, queryable, replayable) |
| **Multi-tenant safety** | N/A — single user's session | Each task is its own workflow ID; isolation via Temporal namespaces |

## When to use which

**Reach for Claude Code dynamic workflows when:**

- You want to audit *this codebase* for bugs, security issues, or migration opportunities.
- You're porting `src/activities.ts` or `src/workflows.ts` to a new pattern and want parallel investigation.
- You're doing one-time deep work where convergent verification matters more than cost.

**Stay with this service when:**

- A message arrives from the Threadbase backend and needs to be processed reliably.
- You need retries, durable state, or a system of record for what each task did.
- You need horizontal scale by adding workers.
- You need a result to be returned to a caller via a workflow ID, not produced in a chat session.

## Could one replace the other?

No, in either direction.

- Replacing this service with dynamic workflows would lose Temporal's durability, retry policy, replay, and the request/response shape the Threadbase backend depends on. Dynamic workflows have no equivalent of `startTask(...)` returning a workflow ID a caller can later query.
- Replacing dynamic workflows with this service would be over-engineering for one-off analysis — you'd be standing up Temporal + a worker pool to do what a single Claude Code session does interactively.

## Complementary patterns

- **Dev-time:** use dynamic workflows on this repo for migrations, audits, or refactors of the agent activities.
- **Inside an activity:** if you want agentic behavior *per task* (not the whole pipeline), call the Claude Agent SDK from inside an activity. That's the programmatic SDK, not dynamic workflows.
- **One-off analysis on production data:** dynamic workflows in a session pointed at exported task histories, not bolted into the pipeline.

## References

- Claude blog post: <https://claude.com/blog/introducing-dynamic-workflows-in-claude-code>
- This project's pipeline: `src/workflows.ts`, `src/activities.ts`
- Temporal docs: <https://docs.temporal.io>
