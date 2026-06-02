# threadbase-orchestration

Durable multi-agent task orchestration for Threadbase, built on **Temporal**.
Incoming messages run through a pipeline of AI agents (worker → reviewer →
sign-off), with each stage independently retriable and the whole workflow
surviving crashes — no Kafka, no hand-rolled queue.

```
Threadbase backend (client) ──start──▶ Temporal server (durable state)
        ▲                                      │ dispatches tasks
        │ query / result                       ▼
        └────────────────────────  Worker process (AI-agent activities → Claude)
```

## Layout

| File | Role |
|---|---|
| `docker-compose.yml` | Local Temporal + Postgres + Web UI |
| `src/shared/types.ts` | JSON-serializable domain types |
| `src/shared/config.ts` | Connection / model config from env |
| `src/activities.ts` | **The AI agents.** All LLM calls + I/O live here |
| `src/workflows.ts` | **The pipeline.** Deterministic orchestration |
| `src/worker.ts` | The agent process (your scalable worker pool) |
| `src/client.ts` | Helper your Threadbase backend imports |
| `src/starter.ts` | Demo script: kick off one task and watch it |

## Run it

```bash
# 1. install
npm install

# 2. start Temporal (UI at http://localhost:8080)
npm run temporal:up

# 3. configure
cp .env.example .env        # set ANTHROPIC_API_KEY
export $(grep -v '^#' .env | xargs)   # or use your own dotenv loader

# 4. start the agent worker (leave running)
npm run worker

# 5. in another terminal, kick off a task
npm run kickoff
```

Watch the execution live in the Web UI at <http://localhost:8080>.

Reset everything (including the DB volume): `npm run temporal:reset`.

## Key rules

- **Workflow code is deterministic** — no network/DB/`Date.now()`/`Math.random()`.
  All side effects go in activities, which Temporal records and replays.
- **Activities are the AI agents** — non-determinism (LLM calls) belongs here and
  is retried automatically per the policy in `workflows.ts`.
- **Scale by running more workers** on the `agent-tasks` task queue. No code change.

## Wiring into Threadbase

In your message handler, import from `src/client.ts`:

```ts
import { startTask } from './client';

app.post('/messages', async (req, res) => {
  const workflowId = await startTask(toTask(req.body));
  res.json({ workflowId }); // returns instantly; pipeline runs durably
});
```

For live UI updates, either poll `getStage()` or have activities publish
progress to Redis pub/sub keyed by `task.sessionId` and relay over your existing
WebSocket layer (the workflow stays the durable source of truth).

## Production

`auto-setup` is dev-only. For production use **Temporal Cloud** (managed) or the
`temporalio/server` image against a managed Postgres; only the connection
address/credentials in `.env` change — workflow and worker code stay identical.
