# threadbase-orchestration

The Temporal worker behind Threadbase's multi-agent mode.
Each streamer session runs one long-lived workflow, and each message the phone sends runs a turn through a pipeline of agents (worker → reviewer → sign-off), with every step retried by Temporal and the whole session surviving crashes.

```
phone ──▶ tb-streamer ──start / signal──▶ Temporal ──▶ this worker (agent activities → Claude)
            ▲                                              │
            └──────── signed progress webhook ─────────────┘
```

## How a session runs

- **tb-streamer starts the session.** With `MULTI_AGENT_FLOW=true`, it starts `orchestratorWorkflow(sessionId)` with id `session-<sessionId>` on the `agent-tasks` queue.
- **Each message is a `userInput` signal.** The orchestrator queues signals and runs them one at a time as child `turnWorkflow`s.
- **A turn moves through stages:** `processing` (worker drafts), `review` (reviewer scores), `rework` (worker revises, up to 2 times), `sign-off`, `done`.
- **Progress goes back by webhook.** Every stage change and agent answer is POSTed to `PROGRESS_WEBHOOK_URL/<sessionId>/progress`, signed as described below.
- **Every turn ends** with an `agent_output` at `done` or a `terminal_failure`, which releases the streamer's turn lock.
- **Queries:** `stage` returns the current stage, `queueDepth` the number of waiting inputs.

The wire types (`ProgressEvent`, `UserInputSignal`, stages) come from `@threadbase-sh/agent-types`, the [agent-types](https://github.com/RonenMars/threadbase-agent-types) repo checked out at `packages/agent-types` as a submodule pinned to a release tag.
Each agent-types release opens a PR here that bumps the submodule (`.github/workflows/update-agent-types.yml`).

## Webhook signing

Each POST carries:

- `X-Timestamp`: unix seconds; the streamer accepts 300 seconds of clock skew.
- `X-Progress-Signature`: hex HMAC-SHA256 of `"<timestamp>.<raw body>"` keyed by `PROGRESS_HMAC_SECRET`.
- `X-Progress-Event-Id`: the event's id, which the streamer uses to drop duplicates.

A retry is signed again with a fresh timestamp.
A 4xx response is final; 5xx and network errors are retried with backoff.
The full scheme is in [`signed-http-webhook-guide.md`](signed-http-webhook-guide.md).

## Layout

| Path | Role |
|---|---|
| `src/workflows/orchestrator.ts` | The session workflow: signal queue, one turn at a time |
| `src/workflows/turn.ts` | One turn: worker → reviewer → rework → sign-off |
| `src/workflows/signals.ts` | `userInput` signal, `stage` and `queueDepth` queries |
| `src/activities/agents.ts` | The agents: every LLM call lives here |
| `src/activities/progress.ts` | The signed progress webhook |
| `src/client.ts` | Start, signal, query and end sessions (used by the smoke scripts) |
| `src/worker.ts` | The worker process |
| `src/scripts/` | Smoke scripts and a mock webhook receiver |
| `packages/agent-types/` | The wire types (submodule) |
| `test/integration/` | Worker and the real streamer progress route in one process |

## Run it

```bash
git submodule update --init      # packages/agent-types
npm install
npm run build:types               # the root typecheck reads its dist/
cp .env.example .env              # set ANTHROPIC_API_KEY
npm run temporal:up               # Temporal on :7233, UI on http://localhost:8080
npm run worker                    # leave running
```

Then either:

- **Against the streamer:** run tb-streamer with `MULTI_AGENT_FLOW=true` and the same `PROGRESS_HMAC_SECRET`, and point `PROGRESS_WEBHOOK_URL` at its `/internal/sessions`.
- **Without the streamer:** `npm run smoke:receiver` in one terminal and `npm run smoke:session` in another.

`npm run temporal:reset` wipes Temporal's database.

## Configuration

| Variable | Default |
|---|---|
| `TEMPORAL_ADDRESS` | `localhost:7233` |
| `TEMPORAL_NAMESPACE` | `default` |
| `TEMPORAL_TASK_QUEUE` | `agent-tasks` |
| `ANTHROPIC_API_KEY` | required |
| `AGENT_MODEL` | `claude-opus-4-7` |
| `PROGRESS_WEBHOOK_URL` | `http://localhost:3456/internal/sessions` |
| `PROGRESS_HMAC_SECRET` | `dev-secret-change-me`; must match the streamer's |
| `PROGRESS_WEBHOOK_ATTEMPTS` | `3` |
| `PROGRESS_WEBHOOK_FIRST_DELAY_MS` | `200` |
| `PROGRESS_WEBHOOK_BACKOFF` | `4` |
| `PROGRESS_WEBHOOK_TIMEOUT_MS` | `2000` |

## Checks

```bash
npm run typecheck && npm test     # unit and integration tests; no Temporal server or API key needed
npm run typecheck:types && npm run test:types   # the agent-types package
```

## Key rules

- **Workflow code is deterministic:** no network, clock or randomness in `src/workflows/`; side effects go in activities, which Temporal records and replays.
- **Event ids come from `workflow.uuid4()`,** so a replayed workflow sends the same ids and the streamer drops the duplicates.
- **Scale by running more workers** on the `agent-tasks` queue.

## Known limits

- Sign-off always approves; there is no human approval step yet.
- Agents answer as text only: no tools and no access to the session's repo.
- The orchestrator never continues as new, so a very long session grows its history without bound.
- tb-streamer does not end the session workflow when a session is killed.
  To end every running session workflow (this also ends live sessions):

  ```bash
  temporal workflow terminate --query 'WorkflowType="orchestratorWorkflow" AND ExecutionStatus="Running"' --reason "orphaned session"
  ```

## Relationship to Claude Code dynamic workflows

[Claude Code dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) and this service solve different problems. Dynamic workflows are an *interactive*, session-scoped fan-out tool for ad-hoc analysis; this service is a *durable* production pipeline driven by the Threadbase backend.

| Dimension | Claude Code dynamic workflows | threadbase-orchestration |
|---|---|---|
| **Trigger** | Developer in a Claude Code session | A message from the phone, via tb-streamer |
| **Durability** | Session-scoped; dies with the session | Event-sourced; survives crashes and restarts |
| **Retries** | Internal verification loops | Per-activity `retryPolicy` enforced by Temporal |
| **Scale model** | One session, many subagents | Many workers on the `agent-tasks` queue |
| **Cost** | Substantially more tokens than a normal session | One LLM call per agent stage per task |
| **Best for** | One-off codebase audits, migrations, deep review | Reliably processing every inbound message |

Dynamic workflows can't replace this pipeline (no durability, no per-step retries, no caller-facing workflow ID). This pipeline can't replace dynamic workflows (over-engineered for ad-hoc analysis). They compose well: use dynamic workflows *on this repo* for migrations and audits.

Full comparison and use-case guidance: [docs/comparisons/claude-code-dynamic-workflows.md](docs/comparisons/claude-code-dynamic-workflows.md).
