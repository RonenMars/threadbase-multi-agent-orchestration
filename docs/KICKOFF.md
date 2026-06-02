# Kick-off — Threadbase Agent Orchestration

> Paste this into Claude Code (or hand it to a collaborator) as the opening
> brief for the project. It frames the mission, the one decision that shapes
> everything, the repo you're starting from, and the first milestones.

---

## Mission

Build a **durable multi-agent task pipeline** for Threadbase. A message enters
the backend and is processed by a configurable chain of AI agents — a worker
agent drafts, a reviewer agent inspects, a PM agent signs off — with a re-work
loop when review fails. The system must survive crashes: in-flight work resumes
instead of being lost.

## The decision that shapes everything

We are using **Temporal as the orchestration + durability layer instead of
Kafka.** The workflow execution *is* the task pool; the Task Queue distributes
work across a fixed pool of agent workers. We do **not** hand-build queues,
state transitions, retries, or recovery — Temporal provides those as a
programming model.

Two hard rules follow from this and must hold everywhere:

1. **Workflow code is deterministic.** No network/DB calls, no `Date.now()`, no
   `Math.random()`, no env reads inside workflows. All side effects are
   activities, whose results Temporal records and replays.
2. **Activities are the AI agents.** Every LLM call and all I/O live in
   activities, which Temporal retries automatically.

## Component map (separate processes)

- **Threadbase backend** — the Temporal *client*. Only starts and observes
  workflows. Stays lean; never runs agent logic.
- **Temporal server** — its own service (Docker locally, Temporal Cloud in prod)
  with a Postgres backend. Owns scheduling, durable state, retries.
- **Agent worker(s)** — separate process hosting the workflow code and the
  AI-agent activities. This is the scalable pool: run more replicas for more
  throughput.

## Starting point

A runnable skeleton is included (`threadbase-orchestration/`). It already has:

- `docker-compose.yml` — local Temporal + Postgres + Web UI (`:8080`)
- `src/activities.ts` — worker/reviewer/PM agents calling Claude
- `src/workflows.ts` — the deterministic pipeline with a re-work loop + a `stage` query
- `src/worker.ts` — the agent process
- `src/client.ts` — the helper the backend imports (`startTask`, `getStage`, `awaitResult`)
- `src/starter.ts` — a demo that kicks off one task and prints the result

Prove the loop end-to-end first:

```bash
npm install
npm run temporal:up          # Temporal + UI at http://localhost:8080
cp .env.example .env         # set ANTHROPIC_API_KEY
npm run worker               # terminal A — agent worker
npm run kickoff              # terminal B — start one task, watch it advance
```

## First milestones

1. **Green path** — stand up the stack, run `npm run kickoff`, confirm the task
   advances `queued → processing → review → sign-off → done` in the Web UI.
2. **Wire into Threadbase** — call `startTask()` from the real message handler;
   return the `workflowId` immediately.
3. **Live progress** — stream stage/output to the frontend. Start with
   `getStage()` polling; then have activities publish progress to Redis pub/sub
   keyed by `sessionId` and relay over the existing WebSocket layer.
4. **Human-in-the-loop sign-off** — replace `productSignOff` with a Temporal
   Signal the UI sends on approval; the workflow waits durably (days if needed).
5. **Scale + isolate** — run multiple workers; give expensive agents their own
   task queue + worker fleet sized independently.

## Guardrails

- Keep the backend a thin client; all agent behavior stays in activities.
- Tune activity retry policies and timeouts deliberately — LLM calls cost money
  and aren't idempotent; use `heartbeat()` on long generations.
- `auto-setup` is dev-only; production uses Temporal Cloud or the
  `temporalio/server` image. Only `.env` changes between environments.

---

*Full architecture rationale (Kafka→Temporal mental model, durability via event
sourcing, scaling patterns, Temporal-vs-Kafka tradeoffs) lives in
`threadbase-agent-orchestration.md`.*
