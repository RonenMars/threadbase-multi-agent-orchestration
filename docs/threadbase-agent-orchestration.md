# Threadbase — Multi-Agent Task Orchestration with Temporal

A durable, scalable architecture for processing incoming messages through a
pipeline of AI agents (worker → reviewer → product manager → …), where each
stage is independently retriable and the whole workflow survives crashes.

---

## 1. Goals

- A **message** enters Threadbase and is processed by a configurable **pipeline of AI agents**.
- Tasks are pulled from a **backlog/pool** and processed by a fixed pool of agents (not one-spawn-per-message).
- The system is **durable**: if a worker, the orchestrator, or the backend crashes, in-flight work resumes instead of being lost.
- New stages (extra reviewers, a PM sign-off, sub-agents) can be added **without re-plumbing** the system.

The key architectural decision: **use Temporal as the orchestration + durability layer instead of Kafka.** With Kafka you'd hand-build the queues, the state transitions, the retries, and the recovery. Temporal gives you all of that as a programming model.

---

## 2. The mental-model shift: Kafka → Temporal

The Kafka design we discussed:

```
backlog → [Kafka topic: tasks] → worker agents
        → [Kafka topic: review] → reviewer agents
        → [Kafka topic: approve] → PM agents → done
```

Here the **topics are the state**, and you write consumers that move messages between topics, plus your own logic for retries, dead-letter handling, and "what state is task #47 in right now?"

The Temporal equivalent:

```
backlog → start a Workflow per task
            └─ workflow code calls: process() → review() → approve()
               each call is an "Activity" run by a worker agent
```

Here the **workflow execution IS the state**. You write the pipeline as ordinary
sequential (or parallel) code; Temporal records every step in a durable event
history, retries failed steps, and reconstructs state on crash. There is no
Kafka. The "current pool of tasks" is simply the set of running workflow
executions, and the Task Queue is what distributes work across your agent pool.

---

## 3. Components & where things run

These are **separate processes/services**, not one monolith:

```
┌─────────────────┐        ┌──────────────────────┐
│ Threadbase      │ start  │  Temporal Server      │
│ Node.js backend │───────▶│  (Cluster)            │
│ (the "client")  │        │  - schedules work     │
│                 │◀──────▶│  - stores event       │
│  WebSocket ↕    │ query/ │    history (durable)  │
└────────┬────────┘ signal │  - Postgres backend   │
         │                 └──────────┬────────────┘
         │ stream to                  │ dispatches tasks
         │ frontend                   ▼
         │              ┌──────────────────────────────┐
   ┌─────▼──────┐       │  Agent Worker Process(es)     │
   │  Frontend  │       │  - poll the Task Queue        │
   │ (web/expo) │       │  - run Workflow code          │
   └────────────┘       │  - run Activities = AI agents │
                        │    (each calls Claude/LLM)    │
                        └──────────────────────────────┘
```

**Who owns what:**

| Concern | Lives where |
|---|---|
| Receiving the user message, auth, WebSocket to frontend | Threadbase main backend |
| Starting the workflow, querying its state | Threadbase backend (acts as a Temporal *client*) |
| Orchestration, scheduling, durable state, retries | Temporal Server (its own service + Postgres) |
| The actual agent logic (LLM calls) | **Worker processes** — separate from the main backend |

> **Answer to "should Temporal go in the main backend or as a side service?"**
> Side service. Run the Temporal Server as its own service (Docker in dev, Temporal Cloud or a self-hosted cluster in prod). Run your **agents as separate worker processes**. Your main backend stays lean — it only *starts* and *observes* workflows. This is what lets you scale and redeploy agents without touching the API server.

> **Answer to "are the agents durable too?"**
> Yes — *if* they're written as Temporal Activities/Workflows. Durability isn't magic; it comes from the execution model. A workflow's progress is event-sourced, so a crashed worker replays its history and continues. An activity (one agent's LLM call) that fails or times out is retried per its retry policy. A loose `setTimeout` process Temporal never saw about can't be recovered — the work has to flow *through* Temporal to be protected.

---

## 4. Durability: how it actually works

Two distinct mechanisms, worth understanding before you build:

**Workflow durability (event sourcing).** Workflow code isn't "run" in the
normal sense — it's *replayed*. Every result (an activity finished, a timer
fired, a signal arrived) is appended to an immutable event history in
Temporal's database. If the worker dies mid-pipeline, a new worker replays the
history to rebuild the exact in-memory state, then continues from where it left
off. This is why **workflow code must be deterministic**: no direct network/DB
calls, no `Date.now()`, no `Math.random()`, no reading env vars inside the
workflow. All side effects go into Activities.

**Activity durability (retries).** Activities are where the messy real world
lives — LLM calls, DB writes, HTTP. They can be non-deterministic and slow.
Temporal wraps each with a configurable retry policy and timeouts. A flaky
Claude call gets retried automatically; a worker that dies mid-activity causes
the activity to be re-dispatched to another worker.

The practical rule: **deterministic orchestration in Workflows, all I/O and
AI calls in Activities.**

---

## 5. Modeling the "pool of tasks"

Two valid patterns — pick based on whether you need centralized scheduling.

### Pattern A — One workflow per message *(recommended starting point)*
Each incoming message starts its own workflow execution. The "backlog/pool" is
just all the live executions; the Task Queue + worker pool naturally load-balance
the agent work. Simple, scales well, easy to reason about.

### Pattern B — A dispatcher workflow over an explicit backlog
A long-running workflow holds a prioritized backlog, pulls tasks, and spawns
**child workflows** for each. Use this only when you need global ordering,
priority, rate-limiting across all tasks, or a literal "10 tasks in a sprint"
batch with cross-task coordination. More moving parts.

Start with A. Reach for B when you actually feel the need.

---

## 6. Project structure

```
threadbase-orchestration/
├── src/
│   ├── workflows.ts        # pipeline definitions (deterministic)
│   ├── activities.ts       # the AI agents (LLM calls live here)
│   ├── worker.ts           # the agent worker process entrypoint
│   ├── client.ts           # helper the backend uses to start/observe workflows
│   └── shared/
│       └── types.ts        # Task, Draft, Review, etc.
├── docker-compose.yml      # local Temporal server + Postgres + UI
└── package.json
```

Install:

```bash
npm i @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity
npm i @anthropic-ai/sdk   # or whatever LLM client your agents use
```

---

## 7. Local Temporal server (dev)

The fastest path for dev is the Temporal CLI dev server (in-memory):

```bash
# brew install temporal
temporal server start-dev      # UI at http://localhost:8233, gRPC at :7233
```

For something closer to prod, use `docker-compose` with the official images
(Temporal + Postgres + Web UI). In production, use **Temporal Cloud** (managed)
or a self-hosted cluster — your worker and client code is identical, only the
connection address/credentials change.

---

## 8. Implementation

### 8.1 Shared types

```typescript
// src/shared/types.ts
export interface Task {
  id: string;
  sessionId: string;        // ties back to the Threadbase session / WS channel
  prompt: string;
  context?: string;
}

export interface Draft  { taskId: string; content: string; }
export interface Review { taskId: string; approved: boolean; notes: string; }
export interface Result { taskId: string; content: string; review: Review; }
```

### 8.2 Activities — *these are your AI agents*

An Activity is just an async function. The fact that it calls an LLM (and is
therefore non-deterministic) is completely fine — non-determinism is only
forbidden in *workflow* code, never in activities.

```typescript
// src/activities.ts
import Anthropic from '@anthropic-ai/sdk';
import { Context } from '@temporalio/activity';
import type { Task, Draft, Review } from './shared/types';

const claude = new Anthropic();

// Worker agent: takes a task, produces a draft.
export async function processTask(task: Task): Promise<Draft> {
  Context.current().heartbeat('processing');   // for long calls
  const msg = await claude.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    messages: [{ role: 'user', content: `${task.context ?? ''}\n\n${task.prompt}` }],
  });
  const content = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
  return { taskId: task.id, content };
}

// Reviewer agent: inspects a draft, returns a verdict.
export async function reviewTask(draft: Draft): Promise<Review> {
  const msg = await claude.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content:
        `Review the following work. Respond ONLY with JSON ` +
        `{"approved": boolean, "notes": string}.\n\n${draft.content}`,
    }],
  });
  const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  return { taskId: draft.taskId, approved: parsed.approved, notes: parsed.notes };
}

// PM agent: final sign-off (stub — extend as needed).
export async function productSignOff(draft: Draft, review: Review): Promise<boolean> {
  return review.approved; // or another LLM call / human-in-the-loop
}
```

> **LLM-specific retry note:** LLM calls cost money and aren't idempotent. Set a
> sane retry policy (`maximumAttempts`, backoff) and a generous
> `startToCloseTimeout`. Use `heartbeat()` on long generations so Temporal can
> detect a truly stuck worker vs. a slow one.

### 8.3 Workflow — the pipeline (deterministic orchestration)

```typescript
// src/workflows.ts
import { proxyActivities, defineQuery, setHandler } from '@temporalio/workflow';
import type * as activities from './activities';
import type { Task, Result } from './shared/types';

const { processTask, reviewTask, productSignOff } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, initialInterval: '2s', backoffCoefficient: 2 },
});

// Lets the backend ask "what stage is this task in?" without polling a DB.
export const stageQuery = defineQuery<string>('stage');

export async function taskPipelineWorkflow(task: Task): Promise<Result> {
  let stage = 'queued';
  setHandler(stageQuery, () => stage);

  stage = 'processing';
  let draft = await processTask(task);

  stage = 'review';
  let review = await reviewTask(draft);

  // Re-work loop: if the reviewer rejects, send it back to the worker.
  let attempts = 0;
  while (!review.approved && attempts < 2) {
    stage = `rework-${++attempts}`;
    draft = await processTask({ ...task, context: `Reviewer notes: ${review.notes}` });
    stage = 'review';
    review = await reviewTask(draft);
  }

  stage = 'sign-off';
  await productSignOff(draft, review);

  stage = 'done';
  return { taskId: task.id, content: draft.content, review };
}
```

This reads like plain code, but every `await` is a durable checkpoint. Crash
after `review`? On restart it replays and resumes at `sign-off` without redoing
`processTask`.

### 8.4 Worker — the agent process

This is the long-running service that *is* your agent pool. Run N replicas to
scale; Temporal load-balances tasks across them off the shared Task Queue.

```typescript
// src/worker.ts
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';

async function run() {
  const connection = await NativeConnection.connect({ address: 'localhost:7233' });
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'agent-tasks',
    workflowsPath: require.resolve('./workflows'),
    activities,
    maxConcurrentActivityTaskExecutions: 10, // tune to control LLM concurrency/cost
  });
  await worker.run();
}
run().catch(err => { console.error(err); process.exit(1); });
```

### 8.5 Triggering from the Threadbase backend

Your existing Node backend becomes a Temporal **client**. When a message lands,
start a workflow and return immediately — the work continues durably.

```typescript
// src/client.ts
import { Connection, Client } from '@temporalio/client';
import { taskPipelineWorkflow, stageQuery } from './workflows';
import type { Task } from './shared/types';

let client: Client;
export async function getClient() {
  if (!client) {
    const connection = await Connection.connect({ address: 'localhost:7233' });
    client = new Client({ connection });
  }
  return client;
}

export async function startTask(task: Task) {
  const c = await getClient();
  const handle = await c.workflow.start(taskPipelineWorkflow, {
    taskQueue: 'agent-tasks',
    workflowId: `task-${task.id}`,  // dedupes: same id won't double-run
    args: [task],
  });
  return handle.workflowId;
}

export async function getStage(taskId: string) {
  const c = await getClient();
  return c.workflow.getHandle(`task-${taskId}`).query(stageQuery);
}
```

In your message handler:

```typescript
app.post('/messages', async (req, res) => {
  const task = toTask(req.body);
  const workflowId = await startTask(task);
  res.json({ workflowId });   // returns instantly; pipeline runs in background
});
```

### 8.6 Streaming results back to the frontend

Temporal isn't a streaming bus, so don't try to push UI updates *out of*
workflow code. Two clean options:

1. **Query-on-interval** — frontend (or backend) calls `getStage()` to show
   `processing → review → done`. Simplest.
2. **Side-channel from activities** — activities publish progress to Redis
   pub/sub (or directly emit a WebSocket event keyed by `task.sessionId`); the
   Threadbase backend subscribes and forwards over the existing WebSocket. Best
   for token-level / real-time UX. Note this channel is *best-effort*; the
   durable source of truth is still the workflow.

For Threadbase, where you already stream over WebSockets, option 2 fits your
existing pattern — activities emit `{sessionId, stage, chunk}` and your WS layer
relays it.

---

## 9. Scaling & extending

- **More throughput** → run more worker replicas on the `agent-tasks` queue. No code change.
- **Isolate expensive agents** → give heavy agents their own Task Queue + worker fleet, sized/scaled independently (e.g. `review-tasks` vs `agent-tasks`).
- **New stage (e.g. security-review agent)** → add an activity + one line in the workflow. No new infrastructure.
- **Sub-agents** → an activity can itself start a child workflow for a complex subtask; the parent waits durably.
- **Human-in-the-loop** → replace `productSignOff` with a Temporal **Signal**: the workflow `await`s a signal that your UI sends when a human approves. It'll wait days if needed, durably.

---

## 10. Temporal vs. Kafka — when each wins

| | **Temporal** | **Kafka** |
|---|---|---|
| You're modeling | a *process/workflow* with stages | a *stream/log* of events |
| State of a task | tracked for you (event history) | you build it |
| Retries, timeouts, recovery | built in | you build it |
| Best for | multi-step agent pipelines, sagas, human-in-loop | high-volume fan-out, event sourcing, decoupled services, analytics |
| Infra to run | Temporal cluster + Postgres | Kafka brokers + Zookeeper/KRaft |

For *this* use case — a few orchestrated AI agents per message with reviews and
retries — Temporal is the better fit. Kafka shines when you have very high event
volume and many independent consumers, which you can always add later *alongside*
Temporal if needed.

---

## 11. Suggested build order

1. `temporal server start-dev` + confirm the Web UI loads.
2. Define `types.ts`, then a trivial `processTask` activity that just echoes.
3. Write the workflow with that one activity; run `worker.ts`.
4. Start a workflow from a tiny script via `client.ts`; watch it in the UI.
5. Make `processTask` call Claude for real. Tune timeouts/retries.
6. Add `reviewTask` + the re-work loop.
7. Wire `startTask` into the Threadbase message handler.
8. Add progress streaming (Query first, then Redis/WS side-channel).
9. Add `productSignOff` / human-in-the-loop signal.
10. Containerize the worker; point client/worker at Temporal Cloud for prod.

---

*Architecture target: Threadbase backend (TypeScript/Node) as Temporal client,
a separate worker fleet hosting AI-agent activities, Temporal as the durable
orchestration layer replacing a hand-rolled Kafka pipeline.*
