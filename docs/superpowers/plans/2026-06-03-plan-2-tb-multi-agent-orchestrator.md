# Plan 2 — tb-multi-agent Orchestrator + Turn Workflow + Progress Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the existing single-shot `taskPipelineWorkflow` into a two-tier durable session: a long-lived **orchestrator workflow** (one per session) that serializes user turns, plus a one-shot **turn workflow** (one per user message) that runs the worker → reviewer → optional rework → sign-off pipeline. Add a **progress activity** that POSTs signed-HMAC events to tb-streamer over HTTP. Wire everything into the existing worker process.

**Architecture:** Two workflows live side-by-side in this repo. The orchestrator is signal-driven (Temporal signals serialize concurrent turns onto an in-workflow queue); turns are spawned as child workflows. Both workflows use `workflow.uuid4()` so emitted `eventId`s survive replay. Activities own all I/O: Anthropic calls and the HMAC-signed webhook POST. The worker continues to use the existing dev Temporal server; no infra changes.

**Tech Stack:** TypeScript 5.6, `@temporalio/workflow` 1.11, `@temporalio/activity` 1.11, `@temporalio/worker` 1.11, `@anthropic-ai/sdk` 0.40, `@threadbase/agent-types` (from Plan 1, already wired as workspace dep). Tests via vitest + `@temporalio/testing` TestWorkflowEnvironment.

---

## Scope

Plan 2 ships ONLY the worker-side changes. It does NOT:

- Run tb-streamer or implement its webhook receiver. The progress activity POSTs to a URL; if no receiver is up, the activity logs and returns success per spec §7.3. A throwaway local mock receiver is used in Task 14 to smoke-test the activity.
- Change tb-streamer's `package.json`, source, or config. That is Plan 3.
- Touch `docs/superpowers/specs/*` or any milestone-B planning docs.

This plan is shippable on its own: at the end, an operator can run `temporal server start-dev`, run `npm run worker`, run `npm run smoke-session` (new), and observe a complete two-turn session with serialized signals + progress events POSTed (logged) at every stage transition.

---

## File Structure

All paths relative to the tb-multi-agent repo root.

| Path | Purpose |
|---|---|
| `src/workflows/index.ts` (NEW) | Barrel — Temporal `workflowsPath` resolves to a single module. Re-exports `orchestratorWorkflow` and `turnWorkflow` and their query/signal definitions. |
| `src/workflows/turn.ts` (NEW) | One-shot per-turn child workflow. Refactored from existing `src/workflows.ts::taskPipelineWorkflow`. Owns processing → review → rework → sign-off. Generates `eventId`s. Emits progress events. |
| `src/workflows/orchestrator.ts` (NEW) | Long-lived per-session workflow. Holds a signal queue, drains one turn at a time, catches `ChildWorkflowFailure`. Emits the `queued` stage transition for waiting turns. |
| `src/workflows/signals.ts` (NEW) | Shared `defineSignal` / `defineQuery` declarations imported by both workflows and `src/client.ts`. |
| `src/workflows/eventSeq.ts` (NEW) | Tiny replay-safe `nextSeq()` factory closed over by each turn workflow. Pure, no Temporal-API surface — keeps the turn workflow readable. |
| `src/workflows.ts` (DELETE) | Replaced entirely by `src/workflows/*`. |
| `src/activities/agents.ts` (NEW) | `processTask`, `reviewTask`, `productSignOff`. Moved verbatim from existing `src/activities.ts`, then extended to accept a per-call progress emitter for `agent_output` events. |
| `src/activities/progress.ts` (NEW) | `sendProgressEvent(event)`. HMAC-SHA256, short retry window (200ms / 800ms), never throws, returns void. |
| `src/activities/index.ts` (NEW) | Barrel — Temporal's `Worker.create({ activities })` expects a flat namespace. Re-exports every activity. |
| `src/activities.ts` (DELETE) | Replaced by `src/activities/*`. |
| `src/shared/types.ts` (MODIFY) | Add `TurnInput` (per-turn child workflow input). Keep existing `Task`, `Draft`, `Review`, `Result` unchanged. |
| `src/shared/config.ts` (MODIFY) | Add `progressWebhookUrl`, `progressHmacSecret`, `webhookTimeoutMs`. |
| `src/client.ts` (MODIFY) | Add `startSession(sessionId)` and `sendUserInput(sessionId, payload)` for the orchestrator. Keep legacy `startTask`/`getStage`/`awaitResult` so the old smoke flow keeps working for now. |
| `src/starter.ts` (MODIFY) | Rename to `src/scripts/smoke-task.ts` — single-turn smoke against the legacy `taskPipelineWorkflow` is no longer the primary path. |
| `src/scripts/smoke-session.ts` (NEW) | New smoke script: starts an orchestrator session, sends two signals back-to-back, awaits both turns. |
| `src/scripts/mock-receiver.ts` (NEW) | Tiny `http.createServer` mock that verifies HMAC and logs received events. Used by the smoke script when no real tb-streamer is up. |
| `package.json` (MODIFY) | Add vitest + `@temporalio/testing`; replace `kickoff` with `smoke:task` and add `smoke:session` + `smoke:receiver`. |
| `vitest.config.ts` (NEW) | vitest config: node env, ignore `dist/` and `packages/`. |
| `test/workflows/turn.test.ts` (NEW) | Unit tests for `turnWorkflow` via Temporal `TestWorkflowEnvironment`. |
| `test/workflows/orchestrator.test.ts` (NEW) | Unit tests for `orchestratorWorkflow` signal-serialization + child failure handling. |
| `test/activities/progress.test.ts` (NEW) | Unit tests for `sendProgressEvent` retry behavior and HMAC stability. |

Why these splits: the spec's §4.1 component table is the contract. Each new file holds one of those components. `eventSeq.ts` is the only file the table didn't name — it exists because both workflows need a deterministic monotonic counter, and threading it through inline would clutter the workflow logic.

---

## Tasks

### Task 1: Add vitest + Temporal testing deps + vitest config

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Add devDependencies to `package.json`**

Edit `package.json` and update the `devDependencies` block to:

```json
  "devDependencies": {
    "@temporalio/testing": "^1.11.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
```

- [ ] **Step 2: Add the scripts**

Inside the `scripts` block, replace the existing `"kickoff"` line with both `smoke:task` and `smoke:session`, and add `smoke:receiver` and `test`:

```json
    "smoke:task": "tsx src/scripts/smoke-task.ts",
    "smoke:session": "tsx src/scripts/smoke-session.ts",
    "smoke:receiver": "tsx src/scripts/mock-receiver.ts",
    "test": "vitest run",
```

The full `scripts` block should now look like:

```json
  "scripts": {
    "temporal:up": "docker compose up -d",
    "temporal:down": "docker compose down",
    "temporal:reset": "docker compose down -v",
    "worker": "tsx watch src/worker.ts",
    "smoke:task": "tsx src/scripts/smoke-task.ts",
    "smoke:session": "tsx src/scripts/smoke-session.ts",
    "smoke:receiver": "tsx src/scripts/mock-receiver.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build:types": "npm --workspace @threadbase/agent-types run build",
    "typecheck:types": "npm --workspace @threadbase/agent-types run typecheck",
    "test:types": "npm --workspace @threadbase/agent-types test"
  },
```

- [ ] **Step 3: Install**

```bash
npm install
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'packages/**'],
    // Temporal TestWorkflowEnvironment spins up a real Temporal in-process —
    // give it room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 5: Verify the toolchain runs**

```bash
npx vitest --version
```

Expected: prints a version string starting with `2.`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "build: add vitest and temporal testing"
```

---

### Task 2: Extend shared types with `TurnInput`

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Read the existing file** (already known — has `Task`, `Draft`, `Review`, `Result`).

- [ ] **Step 2: Append `TurnInput` to the file**

Edit `src/shared/types.ts` to add at the bottom (do NOT modify the existing four interfaces):

```ts
import type { ConversationTurn } from '@threadbase/agent-types';

/**
 * Per-turn child workflow input. The orchestrator passes this when starting a
 * `turnWorkflow`. It is built by stitching the user's prompt onto a snapshot
 * of conversation history that tb-streamer composed.
 */
export interface TurnInput {
  sessionId: string;
  turnId: string;
  prompt: string;
  conversationHistory: ConversationTurn[];
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors (the import resolves because `@threadbase/agent-types` is a workspace dep from Plan 1).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add TurnInput for per-turn child workflow"
```

---

### Task 3: Add webhook config

**Files:**
- Modify: `src/shared/config.ts`

- [ ] **Step 1: Replace the file contents**

Write `src/shared/config.ts`:

```ts
// Tiny config helper so connection details live in one place.

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  // Temporal
  address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'agent-tasks',

  // Anthropic
  model: process.env.AGENT_MODEL ?? 'claude-opus-4-7',

  // Progress webhook (worker → tb-streamer)
  progressWebhookUrl: process.env.PROGRESS_WEBHOOK_URL ?? 'http://localhost:3456/internal/sessions',
  progressHmacSecret: process.env.PROGRESS_HMAC_SECRET ?? 'dev-secret-change-me',
  webhookAttempts: Number(process.env.PROGRESS_WEBHOOK_ATTEMPTS ?? 3),
  webhookFirstDelayMs: Number(process.env.PROGRESS_WEBHOOK_FIRST_DELAY_MS ?? 200),
  webhookBackoffMultiplier: Number(process.env.PROGRESS_WEBHOOK_BACKOFF ?? 4),
  webhookTimeoutMs: Number(process.env.PROGRESS_WEBHOOK_TIMEOUT_MS ?? 2_000),
} as const;

// Forces a runtime check if any caller wants strict mode later. Unused for now
// since defaults are dev-safe; kept exported so the smoke scripts can opt in.
export function assertProductionConfig(): void {
  if (config.progressHmacSecret === 'dev-secret-change-me') {
    throw new Error('PROGRESS_HMAC_SECRET is the dev default; set it before running outside dev.');
  }
  required('ANTHROPIC_API_KEY');
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/config.ts
git commit -m "feat(config): add progress webhook settings"
```

---

### Task 4: Add the workflow signal/query declarations

**Files:**
- Create: `src/workflows/signals.ts`

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p src/workflows
```

Write `src/workflows/signals.ts`:

```ts
// Shared Temporal signal and query identities for the multi-agent workflows.
//
// Kept in their own file so both workflow modules AND src/client.ts can import
// the SAME signal/query objects — Temporal compares by identity (.name) so
// re-declaration in two places would be a sneaky bug.

import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { UserInputSignal } from '@threadbase/agent-types';

export const userInputSignal = defineSignal<[UserInputSignal]>('userInput');

/** Current high-level stage of the orchestrator (or the active turn). */
export const stageQuery = defineQuery<string>('stage');

/** Number of turns enqueued but not yet processing (0 when idle). */
export const queueDepthQuery = defineQuery<number>('queueDepth');
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. The file isn't imported anywhere yet, but it must compile in isolation.

- [ ] **Step 3: Commit**

```bash
git add src/workflows/signals.ts
git commit -m "feat(workflows): declare userInput signal and queries"
```

---

### Task 5: Add the replay-safe sequence helper

**Files:**
- Create: `src/workflows/eventSeq.ts`

- [ ] **Step 1: Write the file**

```ts
// src/workflows/eventSeq.ts
//
// Deterministic monotonic counter for a single turn's progress events.
// Created INSIDE workflow code, so the counter state lives in the workflow's
// in-memory state — Temporal rebuilds it on replay by re-running the workflow
// up to the current point. No clocks, no randomness, no I/O.

export function createSeq(start = 0): () => number {
  let n = start;
  return () => n++;
}
```

This file has no Temporal import on purpose — it's pure, replay-safe by construction (no `Date`, `Math.random`, etc.). Workflow code calls `createSeq()` once per turn and uses the returned function on every event.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/workflows/eventSeq.ts
git commit -m "feat(workflows): add deterministic event sequence helper"
```

---

### Task 6: Progress activity — failing test

**Files:**
- Create: `test/activities/progress.test.ts`

- [ ] **Step 1: Create the test directory**

```bash
mkdir -p test/activities
```

- [ ] **Step 2: Write the failing test**

```ts
// test/activities/progress.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import type { ProgressEvent } from '@threadbase/agent-types';

import { sendProgressEvent, __resetWebhookConfigForTests } from '../../src/activities/progress';

const SECRET = 'unit-secret';

function makeEvent(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    sessionId: 'sess_t',
    turnId: 'turn_t',
    eventId: 'evt_t',
    seq: 0,
    type: 'stage_transition',
    stage: 'processing',
    timestamp: 1717430000,
    ...overrides,
  };
}

function startServer(handler: (req: { headers: Record<string, string>; body: Buffer }) => { status: number }): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const result = handler({
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
          ),
          body: Buffer.concat(chunks),
        });
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: result.status < 400 }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('sendProgressEvent', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(() => {
    process.env.PROGRESS_HMAC_SECRET = SECRET;
    process.env.PROGRESS_WEBHOOK_ATTEMPTS = '3';
    process.env.PROGRESS_WEBHOOK_FIRST_DELAY_MS = '5';
    process.env.PROGRESS_WEBHOOK_BACKOFF = '2';
    process.env.PROGRESS_WEBHOOK_TIMEOUT_MS = '1000';
    __resetWebhookConfigForTests();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('POSTs the event with a valid HMAC and event-id header', async () => {
    const received: Array<{ headers: Record<string, string>; body: Buffer }> = [];
    ({ server, baseUrl } = await startServer((req) => {
      received.push(req);
      return { status: 200 };
    }));
    process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
    __resetWebhookConfigForTests();

    const ev = makeEvent({ eventId: 'evt_42' });
    await sendProgressEvent(ev);

    expect(received).toHaveLength(1);
    const rcv = received[0];
    expect(rcv.headers['x-progress-event-id']).toBe('evt_42');

    const expected = crypto.createHmac('sha256', SECRET).update(rcv.body).digest('hex');
    expect(rcv.headers['x-progress-signature']).toBe(expected);
  });

  it('retries on 5xx then succeeds', async () => {
    let calls = 0;
    ({ server, baseUrl } = await startServer(() => {
      calls += 1;
      return { status: calls < 3 ? 500 : 200 };
    }));
    process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
    __resetWebhookConfigForTests();

    await sendProgressEvent(makeEvent({ eventId: 'evt_retry' }));
    expect(calls).toBe(3);
  });

  it('gives up after the configured attempt cap and resolves without throwing', async () => {
    let calls = 0;
    ({ server, baseUrl } = await startServer(() => {
      calls += 1;
      return { status: 500 };
    }));
    process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
    __resetWebhookConfigForTests();

    // Must NOT throw: spec §7.3 says webhook failure never fails the activity.
    await expect(sendProgressEvent(makeEvent({ eventId: 'evt_giveup' }))).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('treats a connection refused as a transport error and gives up after retries', async () => {
    // Pick a port that's almost certainly free, then close it so the connect fails.
    const { server: tmp } = await startServer(() => ({ status: 200 }));
    const addr = (tmp.address() as AddressInfo);
    await new Promise<void>((r) => tmp.close(() => r()));
    process.env.PROGRESS_WEBHOOK_URL = `http://127.0.0.1:${addr.port}/internal/sessions`;
    __resetWebhookConfigForTests();

    await expect(sendProgressEvent(makeEvent({ eventId: 'evt_refused' }))).resolves.toBeUndefined();
  });

  it('serializes the payload to JSON and signs the exact bytes that are sent', async () => {
    let bodyHex = '';
    ({ server, baseUrl } = await startServer((req) => {
      bodyHex = req.body.toString('utf8');
      return { status: 200 };
    }));
    process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
    __resetWebhookConfigForTests();

    const ev = makeEvent({
      eventId: 'evt_serialize',
      payload: { content: 'with "quotes" and \n newlines' },
      type: 'agent_output',
    });
    await sendProgressEvent(ev);

    const parsed = JSON.parse(bodyHex) as ProgressEvent;
    expect(parsed.eventId).toBe('evt_serialize');
    expect((parsed.payload as { content: string }).content).toContain('newlines');
  });
});
```

The test file imports `__resetWebhookConfigForTests`; the activity exports that as a testing hook so each test can re-read env vars. The activity does NOT depend on Temporal's `Context` for the network call (the helper is callable outside an activity too, which is how the test runs it).

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- test/activities/progress.test.ts
```

Expected: FAIL with `Failed to resolve import '../../src/activities/progress'`.

---

### Task 7: Progress activity — implementation

**Files:**
- Create: `src/activities/progress.ts`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p src/activities
```

- [ ] **Step 2: Write the activity**

```ts
// src/activities/progress.ts
//
// Fire-and-forget HMAC-signed webhook from worker activities to tb-streamer.
//
// Semantics (spec §7.3):
// - Short transport retry window: a few attempts with light backoff.
// - NEVER throws. Webhook failure never fails the surrounding activity.
// - Worker activity retry policy is for LLM/business failures, not webhooks.

import crypto from 'node:crypto';
import type { ProgressEvent } from '@threadbase/agent-types';
import { config } from '../shared/config';

interface WebhookConfig {
  url: string;
  secret: string;
  attempts: number;
  firstDelayMs: number;
  backoff: number;
  timeoutMs: number;
}

let cached: WebhookConfig | undefined;

function readConfig(): WebhookConfig {
  if (cached) return cached;
  cached = {
    url: config.progressWebhookUrl,
    secret: config.progressHmacSecret,
    attempts: Math.max(1, config.webhookAttempts),
    firstDelayMs: Math.max(0, config.webhookFirstDelayMs),
    backoff: Math.max(1, config.webhookBackoffMultiplier),
    timeoutMs: Math.max(1, config.webhookTimeoutMs),
  };
  return cached;
}

/** Test hook — invalidate the cached config so test env vars re-read. */
export function __resetWebhookConfigForTests(): void {
  cached = undefined;
  // Also re-read `config` from env in tests by deleting require-cache for the
  // shared config module. The simpler path is to mutate the cached object;
  // since the smoke/test code mutates env BEFORE the first call, the cached
  // version is whatever was current then. Reset is sufficient.
}

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function postOnce(cfg: WebhookConfig, ev: ProgressEvent): Promise<{ ok: boolean; status: number }> {
  const body = JSON.stringify(ev);
  const signature = sign(body, cfg.secret);
  // Append sessionId to the URL per spec §5.1 — POST /internal/sessions/:sessionId/progress.
  const url = `${cfg.url.replace(/\/$/, '')}/${encodeURIComponent(ev.sessionId)}/progress`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-progress-signature': signature,
        'x-progress-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-progress-event-id': ev.eventId,
      },
      body,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Activity entry point. Best-effort POST with a short retry window.
 * Never throws — see spec §7.3 sub-decision 2.
 */
export async function sendProgressEvent(ev: ProgressEvent): Promise<void> {
  const cfg = readConfig();
  let delay = cfg.firstDelayMs;

  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    try {
      const { ok, status } = await postOnce(cfg, ev);
      if (ok) return;
      // 4xx (e.g. 401 from bad HMAC) is a config error, not transient — log and stop.
      if (status >= 400 && status < 500) {
        // eslint-disable-next-line no-console
        console.warn(`[progress] non-retryable ${status} for ${ev.eventId}; giving up`);
        return;
      }
      // 5xx — fall through to retry.
      // eslint-disable-next-line no-console
      console.warn(`[progress] attempt ${attempt}/${cfg.attempts} got ${status} for ${ev.eventId}`);
    } catch (err) {
      // Transport error (timeout, ECONNREFUSED, etc.). Treat as retryable.
      // eslint-disable-next-line no-console
      console.warn(`[progress] attempt ${attempt}/${cfg.attempts} threw for ${ev.eventId}:`, err);
    }

    if (attempt < cfg.attempts) {
      await sleep(delay);
      delay = delay * cfg.backoff;
    }
  }
  // All attempts spent. Log and return — never throw.
  // eslint-disable-next-line no-console
  console.warn(`[progress] gave up after ${cfg.attempts} attempts for ${ev.eventId}`);
}
```

A note on the test hook: `__resetWebhookConfigForTests` only clears the in-module cache. The tests mutate `process.env` BEFORE each call, then call the reset, so the next `readConfig()` re-reads the live module-level `config` object. Because `src/shared/config.ts` reads env at import time, the test still sees stale values if they were already imported.

The fix: tests will additionally `vi.resetModules()` before each setup so `config` is re-evaluated. Update the test:

```ts
// In test/activities/progress.test.ts, replace the imports block with:
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ProgressEvent } from '@threadbase/agent-types';

let sendProgressEvent: typeof import('../../src/activities/progress').sendProgressEvent;
let __resetWebhookConfigForTests: typeof import('../../src/activities/progress').__resetWebhookConfigForTests;
```

And inside `beforeEach`, before any `import`-based calls:

```ts
  vi.resetModules();
  const mod = await import('../../src/activities/progress');
  sendProgressEvent = mod.sendProgressEvent;
  __resetWebhookConfigForTests = mod.__resetWebhookConfigForTests;
```

Apply both edits to the test file. The activity itself is fine as written.

- [ ] **Step 3: Run the test to verify it passes**

```bash
npm test -- test/activities/progress.test.ts
```

Expected: PASS, 5 tests green.

- [ ] **Step 4: Commit**

```bash
git add src/activities/progress.ts test/activities/progress.test.ts
git commit -m "feat(activities): add HMAC-signed progress webhook"
```

---

### Task 8: Move existing agent activities into the new directory

**Files:**
- Create: `src/activities/agents.ts`
- Create: `src/activities/index.ts`
- Delete: `src/activities.ts`

- [ ] **Step 1: Create `src/activities/agents.ts`**

Copy the current `src/activities.ts` contents into `src/activities/agents.ts`, then fix the relative paths. Write `src/activities/agents.ts`:

```ts
// src/activities/agents.ts
//
// ACTIVITIES = your AI agents.
//
// An Activity is just an async function. It is THE place for all I/O and all
// non-determinism: network calls, DB writes, and — crucially here — LLM calls.
// Temporal retries activities per the policy set in the workflow, so a flaky
// Claude call recovers automatically.

import Anthropic from '@anthropic-ai/sdk';
import { Context } from '@temporalio/activity';
import { config } from '../shared/config';
import type { Task, Draft, Review } from '../shared/types';

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from env

function textOf(msg: Anthropic.Message): string {
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

// --- Worker agent: takes a task, produces a draft ---------------------------
export async function processTask(task: Task): Promise<Draft> {
  Context.current().heartbeat('processing');
  const msg = await claude.messages.create({
    model: config.model,
    max_tokens: 4096,
    messages: [
      { role: 'user', content: `${task.context ?? ''}\n\n${task.prompt}`.trim() },
    ],
  });
  return { taskId: task.id, content: textOf(msg) };
}

// --- Reviewer agent: inspects a draft, returns a verdict --------------------
export async function reviewTask(draft: Draft): Promise<Review> {
  const msg = await claude.messages.create({
    model: config.model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content:
          'Review the following work for correctness and quality. ' +
          'Respond ONLY with JSON: {"approved": boolean, "notes": string}. ' +
          'No prose, no markdown fences.\n\n' +
          draft.content,
      },
    ],
  });

  const raw = textOf(msg).replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(raw) as { approved: boolean; notes: string };
    return { taskId: draft.taskId, approved: !!parsed.approved, notes: parsed.notes ?? '' };
  } catch {
    return { taskId: draft.taskId, approved: false, notes: `Unparseable review: ${raw}` };
  }
}

// --- PM agent: final sign-off ---------------------------------------------
export async function productSignOff(_draft: Draft, review: Review): Promise<boolean> {
  return review.approved;
}
```

- [ ] **Step 2: Create `src/activities/index.ts`**

```ts
// src/activities/index.ts
// Barrel for Temporal's flat activity namespace. Worker.create({ activities })
// expects a single object exposing every callable activity by name.

export { processTask, reviewTask, productSignOff } from './agents';
export { sendProgressEvent } from './progress';
```

- [ ] **Step 3: Delete the old activities file**

```bash
git rm src/activities.ts
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: errors in `src/worker.ts` and `src/workflows.ts` because they still import from `./activities` — those imports now resolve to `./activities/index` automatically, so this should still succeed. If TS complains about an ambiguous import (rare), update the imports in those two files to `./activities/index` explicitly. The next tasks rewrite both files anyway.

- [ ] **Step 5: Commit**

```bash
git add src/activities src/activities.ts
git commit -m "refactor(activities): split into directory module"
```

---

### Task 9: Turn workflow — failing test

**Files:**
- Create: `test/workflows/turn.test.ts`

- [ ] **Step 1: Create the test directory**

```bash
mkdir -p test/workflows
```

- [ ] **Step 2: Write the failing test**

```ts
// test/workflows/turn.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { nanoid } from 'nanoid';
import type { ProgressEvent } from '@threadbase/agent-types';

import type { TurnInput } from '../../src/shared/types';
import type { Draft, Review } from '../../src/shared/types';

let env: TestWorkflowEnvironment;
let workflowsPath: string;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  workflowsPath = require.resolve('../../src/workflows');
});

afterAll(async () => {
  await env?.teardown();
});

interface ScenarioOptions {
  reviewerApprovesAfter: number; // 0 = approves on first review; 1 = after rework #1; 2 = after rework #2; 3 = never (rework cap)
}

function makeStubActivities(emitted: ProgressEvent[], opts: ScenarioOptions) {
  let reviewCalls = 0;

  return {
    processTask: async (task: { id: string; prompt: string; context?: string }): Promise<Draft> => ({
      taskId: task.id,
      content: `draft for ${task.id} (ctx=${task.context ?? ''})`,
    }),
    reviewTask: async (draft: Draft): Promise<Review> => {
      const callIndex = reviewCalls;
      reviewCalls += 1;
      const approved = callIndex >= opts.reviewerApprovesAfter;
      return { taskId: draft.taskId, approved, notes: approved ? '' : 'please revise' };
    },
    productSignOff: async (_d: Draft, _r: Review) => true,
    sendProgressEvent: async (ev: ProgressEvent) => {
      emitted.push(ev);
    },
  };
}

async function runTurnWorkflow(emitted: ProgressEvent[], opts: ScenarioOptions) {
  const { turnWorkflow } = await import('../../src/workflows/turn');
  const taskQueue = `tq-${nanoid(6)}`;

  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: makeStubActivities(emitted, opts),
  });

  const input: TurnInput = {
    sessionId: 'sess_test',
    turnId: `turn_${nanoid(6)}`,
    prompt: 'do the thing',
    conversationHistory: [],
  };

  const handle = await env.client.workflow.start(turnWorkflow, {
    taskQueue,
    workflowId: `turn-${input.turnId}`,
    args: [input],
  });

  await worker.runUntil(handle.result());
  return await handle.result();
}

describe('turnWorkflow', () => {
  it('emits stage transitions: processing → review → sign-off → done (happy path)', async () => {
    const emitted: ProgressEvent[] = [];
    const result = await runTurnWorkflow(emitted, { reviewerApprovesAfter: 0 });

    const stages = emitted
      .filter((e) => e.type === 'stage_transition')
      .map((e) => e.stage);
    expect(stages).toEqual(['processing', 'review', 'sign-off', 'done']);
    expect(result.review.approved).toBe(true);
    expect(result.reworkAttempts).toBe(0);
  });

  it('loops up to 2 reworks then signs off when reviewer approves rework #1', async () => {
    const emitted: ProgressEvent[] = [];
    const result = await runTurnWorkflow(emitted, { reviewerApprovesAfter: 1 });

    const stages = emitted
      .filter((e) => e.type === 'stage_transition')
      .map((e) => e.stage);
    expect(stages).toEqual(['processing', 'review', 'rework', 'review', 'sign-off', 'done']);
    expect(result.reworkAttempts).toBe(1);
  });

  it('caps rework at 2 and emits reviewerOverruled on the final agent_output', async () => {
    const emitted: ProgressEvent[] = [];
    const result = await runTurnWorkflow(emitted, { reviewerApprovesAfter: 3 });

    const stages = emitted
      .filter((e) => e.type === 'stage_transition')
      .map((e) => e.stage);
    expect(stages).toEqual([
      'processing', 'review',
      'rework', 'review',
      'rework', 'review',
      'sign-off', 'done',
    ]);
    expect(result.reworkAttempts).toBe(2);

    const finalOutput = [...emitted].reverse().find(
      (e) => e.type === 'agent_output' && (e.payload as { reviewerOverruled?: boolean })?.reviewerOverruled,
    );
    expect(finalOutput).toBeDefined();
    expect((finalOutput!.payload as { content: string }).content).toContain('draft for');
  });

  it('attaches reworkAttempt to rework stage_transitions', async () => {
    const emitted: ProgressEvent[] = [];
    await runTurnWorkflow(emitted, { reviewerApprovesAfter: 2 });

    const reworks = emitted.filter((e) => e.stage === 'rework');
    expect(reworks.map((r) => r.reworkAttempt)).toEqual([1, 2]);
  });

  it('assigns monotonic seq values per turn starting at 0', async () => {
    const emitted: ProgressEvent[] = [];
    await runTurnWorkflow(emitted, { reviewerApprovesAfter: 0 });
    const seqs = emitted.map((e) => e.seq);
    // strictly increasing
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(0);
  });

  it('uses the turnInput.turnId on every emitted event', async () => {
    const emitted: ProgressEvent[] = [];
    const result = await runTurnWorkflow(emitted, { reviewerApprovesAfter: 0 });
    // result.taskId is the turn id (we reuse the field name from Plan-1 spec).
    expect(emitted.every((e) => e.turnId === result.taskId)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- test/workflows/turn.test.ts
```

Expected: FAIL — likely with `Failed to resolve import '../../src/workflows/turn'` or with `workflowsPath` resolving to the old `workflows.ts`. Either is acceptable as "red"; we proceed to implementation next.

---

### Task 10: Turn workflow — implementation

**Files:**
- Create: `src/workflows/turn.ts`
- Create: `src/workflows/index.ts` (initial — only re-exports turn)

- [ ] **Step 1: Write the turn workflow**

`src/workflows/turn.ts`:

```ts
// src/workflows/turn.ts
//
// ONE-SHOT child workflow per user turn. Drives the worker → reviewer →
// (rework loop, capped at 2) → sign-off pipeline.
//
// Determinism rules:
// - `eventId` is generated via workflow.uuid4() — replay-safe (spec §7.6).
// - `timestamp` is taken via workflow.now() (Temporal-safe replacement for Date.now).
// - `seq` is incremented from a per-turn counter — no global mutable state.

import {
  proxyActivities,
  setHandler,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';
import type { ProgressEvent, AgentOutputPayload } from '@threadbase/agent-types';

import type * as agentActivities from '../activities/agents';
import type * as progressActivities from '../activities/progress';
import type { Draft, Review, Task, TurnInput } from '../shared/types';
import { stageQuery } from './signals';
import { createSeq } from './eventSeq';

const { processTask, reviewTask, productSignOff } = proxyActivities<typeof agentActivities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});

const { sendProgressEvent } = proxyActivities<typeof progressActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 1 }, // helper has its own retry window
});

const MAX_REWORK = 2;

export interface TurnResult {
  taskId: string; // same as turnId
  content: string;
  review: Review;
  reworkAttempts: number;
  reviewerOverruled: boolean;
}

function nowSeconds(): number {
  // workflow.now() returns a Date that's deterministic under replay.
  return Math.floor(Date.now() / 1000);
}

export async function turnWorkflow(input: TurnInput): Promise<TurnResult> {
  const { sessionId, turnId, prompt, conversationHistory } = input;
  let stage = 'processing';
  setHandler(stageQuery, () => stage);

  const seq = createSeq();

  async function emit(partial: Omit<ProgressEvent, 'sessionId' | 'turnId' | 'eventId' | 'seq' | 'timestamp'>): Promise<void> {
    const ev: ProgressEvent = {
      ...partial,
      sessionId,
      turnId,
      eventId: uuid4(),
      seq: seq(),
      timestamp: nowSeconds(),
    };
    await sendProgressEvent(ev);
  }

  // Build the initial Task with the latest user prompt + a string-formed history.
  // History is stitched here (deterministic) rather than inside an activity, so
  // the same Task arrives across activity retries.
  const historyText = conversationHistory
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n');

  const baseTask: Task = {
    id: turnId,
    sessionId,
    prompt,
    context: historyText || undefined,
  };

  // ─── processing ────────────────────────────────────────────────────────
  await emit({ type: 'stage_transition', stage: 'processing' });
  let draft: Draft = await processTask(baseTask);
  await emit({
    type: 'agent_output',
    stage: 'processing',
    payload: { content: draft.content } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
  });

  // ─── review (+ optional rework loop) ───────────────────────────────────
  stage = 'review';
  await emit({ type: 'stage_transition', stage: 'review' });
  let review: Review = await reviewTask(draft);
  await emit({
    type: 'agent_output',
    stage: 'review',
    payload: { content: review.notes || (review.approved ? 'approved' : '') } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
  });

  let reworkAttempts = 0;
  while (!review.approved && reworkAttempts < MAX_REWORK) {
    reworkAttempts += 1;
    stage = 'rework';
    await emit({ type: 'stage_transition', stage: 'rework', reworkAttempt: reworkAttempts });

    draft = await processTask({
      ...baseTask,
      context: `${baseTask.context ?? ''}\n\nReviewer notes to address: ${review.notes}`.trim(),
    });
    await emit({
      type: 'agent_output',
      stage: 'rework',
      reworkAttempt: reworkAttempts,
      payload: { content: draft.content } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
    });

    stage = 'review';
    await emit({ type: 'stage_transition', stage: 'review' });
    review = await reviewTask(draft);
    await emit({
      type: 'agent_output',
      stage: 'review',
      payload: { content: review.notes || (review.approved ? 'approved' : '') } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
    });
  }

  const reviewerOverruled = !review.approved;

  // ─── sign-off ──────────────────────────────────────────────────────────
  stage = 'sign-off';
  await emit({ type: 'stage_transition', stage: 'sign-off' });
  await productSignOff(draft, review);

  // ─── done + final answer ───────────────────────────────────────────────
  stage = 'done';
  await emit({ type: 'stage_transition', stage: 'done' });
  await emit({
    type: 'agent_output',
    stage: 'done',
    payload: {
      content: draft.content,
      reviewerOverruled: reviewerOverruled || undefined,
    } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
  });

  return {
    taskId: turnId,
    content: draft.content,
    review,
    reworkAttempts,
    reviewerOverruled,
  };
}

// Re-export workflowInfo for tests that want to assert on the active workflow.
export { workflowInfo };
```

- [ ] **Step 2: Write a temporary `src/workflows/index.ts` that only re-exports the turn**

```ts
// src/workflows/index.ts
export { turnWorkflow } from './turn';
export { stageQuery, queueDepthQuery, userInputSignal } from './signals';
```

(`orchestratorWorkflow` is added in Task 12 — until then, `workflowsPath` points to this barrel and only the turn workflow is registered.)

- [ ] **Step 3: Delete the old single-file workflows module**

```bash
git rm src/workflows.ts
```

- [ ] **Step 4: Update `src/worker.ts` to point at the new path**

```ts
// src/worker.ts
import './shared/load-env';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';
import { config } from './shared/config';

async function run() {
  const connection = await NativeConnection.connect({ address: config.address });

  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: require.resolve('./workflows'),
    activities,
    maxConcurrentActivityTaskExecutions: 10,
  });

  console.log(
    `Worker up. namespace=${config.namespace} taskQueue=${config.taskQueue} -> ${config.address}`,
  );
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(The only real change from the current file is that `require.resolve('./workflows')` now resolves to `src/workflows/index.ts` instead of `src/workflows.ts`. The import path string is unchanged.)

- [ ] **Step 5: Run the turn test to verify it passes**

```bash
npm test -- test/workflows/turn.test.ts
```

Expected: PASS, 6 tests green.

- [ ] **Step 6: Run the typecheck**

```bash
npm run typecheck
```

Expected: errors in `src/client.ts` (still imports the old `./workflows::taskPipelineWorkflow`). That file is fixed in Task 13. Leave the error for now — it doesn't block the workflow tests.

If TS complains during the test run too (vitest does pre-compile), add a temporary stub `taskPipelineWorkflow` to `src/workflows/index.ts`:

```ts
// TEMP: legacy alias retained until src/client.ts is rewritten in Task 13.
export { turnWorkflow as taskPipelineWorkflow } from './turn';
```

Re-run `npm test -- test/workflows/turn.test.ts` to confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/workflows src/workflows.ts src/worker.ts test/workflows/turn.test.ts
git commit -m "feat(workflows): add turn child workflow with progress events"
```

---

### Task 11: Orchestrator workflow — failing test

**Files:**
- Create: `test/workflows/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/workflows/orchestrator.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { nanoid } from 'nanoid';
import type { ProgressEvent, UserInputSignal } from '@threadbase/agent-types';

let env: TestWorkflowEnvironment;
let workflowsPath: string;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  workflowsPath = require.resolve('../../src/workflows');
});

afterAll(async () => {
  await env?.teardown();
});

function makeActivities(emitted: ProgressEvent[], opts: { failTurnIds?: Set<string> } = {}) {
  return {
    processTask: async (task: { id: string }) => ({ taskId: task.id, content: `draft for ${task.id}` }),
    reviewTask: async (draft: { taskId: string }) => {
      if (opts.failTurnIds?.has(draft.taskId)) {
        throw new Error('reviewer-blew-up');
      }
      return { taskId: draft.taskId, approved: true, notes: '' };
    },
    productSignOff: async () => true,
    sendProgressEvent: async (ev: ProgressEvent) => { emitted.push(ev); },
  };
}

async function startOrchestrator(emitted: ProgressEvent[], opts: { failTurnIds?: Set<string> } = {}) {
  const { orchestratorWorkflow } = await import('../../src/workflows/orchestrator');
  const { userInputSignal } = await import('../../src/workflows/signals');
  const taskQueue = `tq-${nanoid(6)}`;
  const sessionId = `sess-${nanoid(6)}`;

  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    workflowsPath,
    activities: makeActivities(emitted, opts),
  });

  const handle = await env.client.workflow.start(orchestratorWorkflow, {
    taskQueue,
    workflowId: `session-${sessionId}`,
    args: [sessionId],
  });

  return { handle, worker, taskQueue, sessionId, userInputSignal };
}

describe('orchestratorWorkflow', () => {
  it('processes a single userInput signal end-to-end', async () => {
    const emitted: ProgressEvent[] = [];
    const { handle, worker, userInputSignal, sessionId } = await startOrchestrator(emitted);

    const runUntilDone = worker.runUntil(async () => {
      await handle.signal(userInputSignal, {
        turnId: 'turn-1',
        prompt: 'hi',
        conversationHistory: [],
      });
      // wait for the turn's `done` stage transition to flow through
      while (!emitted.some((e) => e.turnId === 'turn-1' && e.stage === 'done')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await handle.cancel();
    });

    await expect(runUntilDone).rejects.toThrow(/CancelledFailure/i);

    expect(emitted.some((e) => e.sessionId === sessionId && e.turnId === 'turn-1' && e.stage === 'done')).toBe(true);
  });

  it('serializes two back-to-back signals — second turn does not start until first completes', async () => {
    const emitted: ProgressEvent[] = [];
    const { handle, worker, userInputSignal } = await startOrchestrator(emitted);

    const runUntilDone = worker.runUntil(async () => {
      await handle.signal(userInputSignal, { turnId: 'turn-A', prompt: 'A', conversationHistory: [] });
      await handle.signal(userInputSignal, { turnId: 'turn-B', prompt: 'B', conversationHistory: [] });

      while (!(
        emitted.some((e) => e.turnId === 'turn-A' && e.stage === 'done') &&
        emitted.some((e) => e.turnId === 'turn-B' && e.stage === 'done')
      )) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await handle.cancel();
    });

    await expect(runUntilDone).rejects.toThrow(/CancelledFailure/i);

    // The first `processing` for turn-A must precede the first `processing` for turn-B.
    const aProcessingIdx = emitted.findIndex((e) => e.turnId === 'turn-A' && e.stage === 'processing');
    const bProcessingIdx = emitted.findIndex((e) => e.turnId === 'turn-B' && e.stage === 'processing');
    expect(aProcessingIdx).toBeGreaterThanOrEqual(0);
    expect(bProcessingIdx).toBeGreaterThan(aProcessingIdx);

    // And turn-B must emit a `queued` stage transition while turn-A is running.
    const queuedForB = emitted.find((e) => e.turnId === 'turn-B' && e.stage === 'queued');
    expect(queuedForB).toBeDefined();
  });

  it('catches a failed child workflow and continues to accept new signals', async () => {
    const emitted: ProgressEvent[] = [];
    const { handle, worker, userInputSignal } = await startOrchestrator(emitted, {
      failTurnIds: new Set(['turn-bad']),
    });

    const runUntilDone = worker.runUntil(async () => {
      // turn-bad will throw inside reviewTask after exhausting Temporal retries
      await handle.signal(userInputSignal, { turnId: 'turn-bad', prompt: 'bad', conversationHistory: [] });
      // wait for terminal_failure
      while (!emitted.some((e) => e.turnId === 'turn-bad' && e.type === 'terminal_failure')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // now send a good turn and confirm it completes
      await handle.signal(userInputSignal, { turnId: 'turn-good', prompt: 'good', conversationHistory: [] });
      while (!emitted.some((e) => e.turnId === 'turn-good' && e.stage === 'done')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await handle.cancel();
    });

    await expect(runUntilDone).rejects.toThrow(/CancelledFailure/i);

    expect(emitted.some((e) => e.turnId === 'turn-bad' && e.type === 'terminal_failure')).toBe(true);
    expect(emitted.some((e) => e.turnId === 'turn-good' && e.stage === 'done')).toBe(true);
  });
});
```

The tests use `worker.runUntil` with a callback that signals, polls, then cancels the long-lived workflow. Cancellation is the expected exit because the orchestrator runs `while (true)`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/workflows/orchestrator.test.ts
```

Expected: FAIL with `Failed to resolve import '../../src/workflows/orchestrator'`.

---

### Task 12: Orchestrator workflow — implementation

**Files:**
- Create: `src/workflows/orchestrator.ts`
- Modify: `src/workflows/index.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// src/workflows/orchestrator.ts
//
// LONG-LIVED workflow per session. Holds a serialized queue of user inputs and
// spawns a one-shot child `turnWorkflow` for each. Catches child failures so
// the session survives a bad turn.

import {
  proxyActivities,
  setHandler,
  setSignalHandler, // ← preserved for clarity (alias)
  condition,
  uuid4,
  executeChild,
  ChildWorkflowFailure,
  CancelledFailure,
  isCancellation,
} from '@temporalio/workflow';
import type { ProgressEvent, UserInputSignal } from '@threadbase/agent-types';

import type * as progressActivities from '../activities/progress';
import {
  userInputSignal,
  stageQuery,
  queueDepthQuery,
} from './signals';
import { turnWorkflow } from './turn';

const { sendProgressEvent } = proxyActivities<typeof progressActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 1 },
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * @param sessionId  tb-streamer's session id (used as the routing key on the
 *                   webhook and as part of the workflowId by convention).
 */
export async function orchestratorWorkflow(sessionId: string): Promise<void> {
  const queue: UserInputSignal[] = [];
  let currentTurnId: string | undefined;
  let stage: string = 'thinking';

  setHandler(stageQuery, () => currentTurnId ? stage : 'idle');
  setHandler(queueDepthQuery, () => queue.length);

  setHandler(userInputSignal, async (sig: UserInputSignal) => {
    queue.push(sig);
    // Spec §7.2: emit a `queued` stage_transition for any signal that arrives
    // while a turn is already running. The first turn in a session never gets
    // a `queued` event because the queue is empty when it arrives.
    if (currentTurnId !== undefined) {
      const ev: ProgressEvent = {
        sessionId,
        turnId: sig.turnId,
        eventId: uuid4(),
        seq: 0,
        type: 'stage_transition',
        stage: 'queued',
        timestamp: nowSeconds(),
      };
      await sendProgressEvent(ev);
    }
  });

  // Main loop. Cancel the workflow to end the session.
  try {
    while (true) {
      await condition(() => queue.length > 0);
      const sig = queue.shift()!;
      currentTurnId = sig.turnId;
      stage = 'processing';

      try {
        await executeChild(turnWorkflow, {
          workflowId: `turn-${sig.turnId}`,
          args: [{
            sessionId,
            turnId: sig.turnId,
            prompt: sig.prompt,
            conversationHistory: sig.conversationHistory,
          }],
        });
      } catch (err) {
        if (err instanceof CancelledFailure || isCancellation(err)) {
          throw err; // propagate session cancellation
        }
        if (err instanceof ChildWorkflowFailure) {
          // Spec §7.5: catch and continue. Emit a per-turn terminal_failure;
          // do NOT touch session status.
          const ev: ProgressEvent = {
            sessionId,
            turnId: sig.turnId,
            eventId: uuid4(),
            seq: 0,
            type: 'terminal_failure',
            timestamp: nowSeconds(),
            payload: { reason: String(err.cause?.message ?? err.message) },
          };
          await sendProgressEvent(ev);
        } else {
          // Unexpected non-child failure (orchestrator-side bug). Re-throw —
          // spec §7.5 says session-level `failed` is reserved for this case.
          throw err;
        }
      } finally {
        currentTurnId = undefined;
        stage = 'thinking';
      }
    }
  } catch (err) {
    // If we got cancelled (session ending), exit cleanly.
    if (err instanceof CancelledFailure || isCancellation(err)) return;
    throw err;
  }
}

// Silence the unused-import linter for the alias preserved at top.
void setSignalHandler;
```

- [ ] **Step 2: Update `src/workflows/index.ts` to export the orchestrator and drop the legacy alias**

```ts
// src/workflows/index.ts
export { turnWorkflow } from './turn';
export { orchestratorWorkflow } from './orchestrator';
export { stageQuery, queueDepthQuery, userInputSignal } from './signals';
```

(Remove the temporary `taskPipelineWorkflow` alias added in Task 10 Step 6, if it was added.)

- [ ] **Step 3: Run the orchestrator tests**

```bash
npm test -- test/workflows/orchestrator.test.ts
```

Expected: PASS, 3 tests green.

- [ ] **Step 4: Run all workflow tests together**

```bash
npm test -- test/workflows
```

Expected: 6 + 3 = 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/orchestrator.ts src/workflows/index.ts test/workflows/orchestrator.test.ts
git commit -m "feat(workflows): add long-lived session orchestrator"
```

---

### Task 13: Update client helpers + delete legacy starter

**Files:**
- Modify: `src/client.ts`
- Rename: `src/starter.ts` → `src/scripts/smoke-task.ts`

- [ ] **Step 1: Rewrite `src/client.ts`**

```ts
// src/client.ts
//
// Temporal client helpers used by tb-streamer (and by the local smoke scripts).
//
// Two public surfaces:
// - Session API (multi-agent mode): startSession + sendUserInput.
// - Legacy task API (single-shot for ad-hoc smoke): startTask + getStage + awaitResult.
//   The legacy API is kept so the existing `smoke:task` script still works.

import { Connection, Client } from '@temporalio/client';
import { config } from './shared/config';
import {
  orchestratorWorkflow,
  turnWorkflow,
  stageQuery,
  userInputSignal,
} from './workflows';
import type { UserInputSignal } from '@threadbase/agent-types';
import type { TurnInput } from './shared/types';

let client: Client | undefined;

export async function getClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({ address: config.address });
    client = new Client({ connection, namespace: config.namespace });
  }
  return client;
}

const sessionWorkflowId = (sessionId: string): string => `session-${sessionId}`;

// ─── multi-agent session API ──────────────────────────────────────────────

/**
 * Start the long-lived orchestrator workflow for a session. Idempotent on the
 * Temporal side: starting twice with the same sessionId is a no-op because of
 * the workflowId reuse policy.
 */
export async function startSession(sessionId: string): Promise<string> {
  const c = await getClient();
  const handle = await c.workflow.start(orchestratorWorkflow, {
    taskQueue: config.taskQueue,
    workflowId: sessionWorkflowId(sessionId),
    args: [sessionId],
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
  });
  return handle.workflowId;
}

/** Send a user message to a running session. */
export async function sendUserInput(sessionId: string, signal: UserInputSignal): Promise<void> {
  const c = await getClient();
  await c.workflow.getHandle(sessionWorkflowId(sessionId)).signal(userInputSignal, signal);
}

/** Cancel a session (cleanly ends the orchestrator workflow). */
export async function endSession(sessionId: string): Promise<void> {
  const c = await getClient();
  await c.workflow.getHandle(sessionWorkflowId(sessionId)).cancel();
}

/** Query the orchestrator's current stage (returns 'idle' when no turn is active). */
export async function getSessionStage(sessionId: string): Promise<string> {
  const c = await getClient();
  return c.workflow.getHandle(sessionWorkflowId(sessionId)).query(stageQuery);
}

// ─── legacy single-turn API (smoke only) ─────────────────────────────────

export async function startTurn(turnInput: TurnInput): Promise<string> {
  const c = await getClient();
  const handle = await c.workflow.start(turnWorkflow, {
    taskQueue: config.taskQueue,
    workflowId: `turn-${turnInput.turnId}`,
    args: [turnInput],
  });
  return handle.workflowId;
}

export async function awaitTurnResult(turnId: string) {
  const c = await getClient();
  return c.workflow.getHandle(`turn-${turnId}`).result();
}

export async function getTurnStage(turnId: string): Promise<string> {
  const c = await getClient();
  return c.workflow.getHandle(`turn-${turnId}`).query(stageQuery);
}
```

- [ ] **Step 2: Create `src/scripts/` and move the smoke-task starter**

```bash
mkdir -p src/scripts
git mv src/starter.ts src/scripts/smoke-task.ts
```

- [ ] **Step 3: Rewrite `src/scripts/smoke-task.ts` to use the new turn API**

```ts
// src/scripts/smoke-task.ts
//
// Single-turn smoke test against the new turnWorkflow directly.
// Useful for verifying the legacy pipeline path still works.
//
// Prereqs:
//   `temporal server start-dev` running
//   `npm run worker` running in another terminal
//   ANTHROPIC_API_KEY set
//
// Run:
//   npm run smoke:task

import '../shared/load-env';
import { nanoid } from 'nanoid';
import { startTurn, awaitTurnResult, getTurnStage } from '../client';
import type { TurnInput } from '../shared/types';

async function main() {
  const turnId = nanoid(8);
  const input: TurnInput = {
    sessionId: 'smoke-task-session',
    turnId,
    prompt: 'Write a concise TypeScript function that debounces an async function.',
    conversationHistory: [],
  };

  console.log(`Starting turn ${turnId}...`);
  await startTurn(input);

  const poll = setInterval(async () => {
    try {
      console.log(`  stage: ${await getTurnStage(turnId)}`);
    } catch {
      /* may have completed */
    }
  }, 1000);

  const result = await awaitTurnResult(turnId);
  clearInterval(poll);

  console.log('\n=== RESULT ===');
  console.log(`approved: ${result.review.approved}  reworks: ${result.reworkAttempts}  overruled: ${result.reviewerOverruled}`);
  console.log(result.content);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: Typecheck the whole repo**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts src/scripts src/starter.ts
git commit -m "refactor(client): add session API and rename legacy starter"
```

---

### Task 14: Mock receiver + session smoke script

**Files:**
- Create: `src/scripts/mock-receiver.ts`
- Create: `src/scripts/smoke-session.ts`

- [ ] **Step 1: Write `src/scripts/mock-receiver.ts`**

```ts
// src/scripts/mock-receiver.ts
//
// A tiny HTTP server that mimics tb-streamer's webhook receiver for local
// smoke testing. Verifies HMAC, prints received events, returns 200.
//
// Run:
//   npm run smoke:receiver
//
// Then run worker + smoke:session in other terminals.

import '../shared/load-env';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { config } from '../shared/config';

const PORT = Number(process.env.MOCK_RECEIVER_PORT ?? 3456);

function verify(body: Buffer, signature: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', config.progressHmacSecret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const signature = String(req.headers['x-progress-signature'] ?? '');
    if (!verify(body, signature)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      console.error(`[mock-receiver] 401 ${req.method} ${req.url}`);
      return;
    }
    try {
      const event = JSON.parse(body.toString('utf8'));
      console.log(`[mock-receiver] ${event.type.padEnd(18)} seq=${String(event.seq).padStart(2)} turn=${event.turnId} stage=${event.stage ?? '-'} content=${(event.payload?.content ?? '').slice(0, 60).replace(/\n/g, ' ')}`);
    } catch (err) {
      console.error('[mock-receiver] parse error', err);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(PORT, () => {
  console.log(`Mock receiver up on http://localhost:${PORT}/internal/sessions/:sessionId/progress`);
});
```

- [ ] **Step 2: Write `src/scripts/smoke-session.ts`**

```ts
// src/scripts/smoke-session.ts
//
// End-to-end smoke for the multi-agent session:
// 1. Start an orchestrator session.
// 2. Send two userInput signals back-to-back.
// 3. Watch progress events arrive at the mock receiver (run in another terminal).
//
// Prereqs:
//   `temporal server start-dev` running
//   `npm run smoke:receiver` running in another terminal
//   `npm run worker` running in another terminal
//   ANTHROPIC_API_KEY set
//
// Run:
//   npm run smoke:session

import '../shared/load-env';
import { nanoid } from 'nanoid';
import { startSession, sendUserInput, endSession, getSessionStage } from '../client';

async function main() {
  const sessionId = `smoke-${nanoid(6)}`;
  console.log(`Starting session ${sessionId}...`);
  await startSession(sessionId);

  const turn1 = `turn-${nanoid(6)}`;
  const turn2 = `turn-${nanoid(6)}`;

  console.log('Sending two signals back-to-back...');
  await sendUserInput(sessionId, {
    turnId: turn1,
    prompt: 'Write a one-line TypeScript debounce function.',
    conversationHistory: [],
  });
  await sendUserInput(sessionId, {
    turnId: turn2,
    prompt: 'Now do the same for throttle.',
    conversationHistory: [{ role: 'user', content: 'Write a one-line TypeScript debounce function.' }],
  });

  // Poll the stage for ~60s so the human can watch.
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      console.log(`  session stage: ${await getSessionStage(sessionId)}`);
    } catch {
      /* might be transient */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('Ending session...');
  await endSession(sessionId);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/mock-receiver.ts src/scripts/smoke-session.ts
git commit -m "feat(scripts): add mock receiver and session smoke"
```

---

### Task 15: Update README / orientation comment in worker.ts

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Update the top-of-file comment to mention both workflows**

Replace the header comment in `src/worker.ts` with:

```ts
// ============================================================================
// WORKER = the long-running agent process. THIS is your agent pool.
//
// It connects to Temporal, polls the Task Queue, and runs:
// - The long-lived `orchestratorWorkflow` (one per session, holds the signal queue).
// - The one-shot `turnWorkflow` (one per user message, drives the agent pipeline).
// - All activities: `processTask`, `reviewTask`, `productSignOff`, `sendProgressEvent`.
//
// Run several replicas to scale; Temporal load-balances across the shared
// Task Queue. Run:  npm run worker
// ============================================================================
```

Keep every line of the actual code below the comment as written in Task 10 Step 4.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "docs(worker): refresh comment for multi-agent mode"
```

---

### Task 16: Final test + smoke verification

- [ ] **Step 1: Run every test in the repo**

```bash
npm test
```

Expected: 22 (agent-types) + 5 (progress) + 6 (turn) + 3 (orchestrator) = 36 tests, all green.

- [ ] **Step 2: Run the typecheck and the package typecheck**

```bash
npm run typecheck
npm run typecheck:types
```

Both: no errors.

- [ ] **Step 3: Verify the worker boots cleanly**

In one terminal:

```bash
temporal server start-dev --ui-port 8233
```

In a second terminal, from the repo root:

```bash
npm run worker
```

Expected log line:

```
Worker up. namespace=default taskQueue=agent-tasks -> localhost:7233
```

Stop both with Ctrl-C. This is verification only; no commit.

- [ ] **Step 4: Verify the mock receiver boots cleanly**

In a fresh terminal:

```bash
npm run smoke:receiver
```

Expected:

```
Mock receiver up on http://localhost:3456/internal/sessions/:sessionId/progress
```

Stop with Ctrl-C. Verification only.

- [ ] **Step 5: Manual end-to-end smoke (optional but recommended before merging)**

Run, in four terminals:

1. `temporal server start-dev --ui-port 8233`
2. `npm run smoke:receiver`
3. `npm run worker`
4. `npm run smoke:session`

Expected:

- The receiver terminal logs ~16+ events for the first turn (processing → review → sign-off → done + agent_outputs) then ~16+ for the second turn.
- The `queued` stage_transition appears for `turn-2` BEFORE turn-1 finishes.
- No 401s — the HMAC matches on both sides.
- The worker terminal shows two child workflows ran.
- The Temporal UI at http://localhost:8233 shows the `session-<id>` orchestrator workflow with two `turn-<id>` children.

If any of these don't hold, debug before considering Plan 2 done. Verification only; no commit.

---

## Self-Review

1. **Spec coverage:**
   - §3.3 wire types — consumed via Plan 1 ✓
   - §3.2 sequence (processing → review → rework? → sign-off → done with agent_output blocks) — turn workflow Tasks 9–10 ✓
   - §3.2 `queued` for serialized turns — orchestrator Task 12 ✓
   - §4.1 module split — Tasks 8, 10, 12, 13, 14 ✓
   - §6.2 progress event generation rules (`workflow.uuid4()`, monotonic `seq`) — Task 10, test assertions in Task 9 ✓
   - §7.1 idempotency (eventId stability) — covered by `uuid4()` use in Task 10; tb-streamer side dedupe is Plan 3 ✓
   - §7.2 serialize turns — Task 12 + tests in Task 11 ✓
   - §7.3 webhook retries, never fail activity — Tasks 6–7 ✓
   - §7.4 rework cap + reviewerOverruled — Task 10 + tests in Task 9 ✓
   - §7.5 catch ChildWorkflowFailure, emit terminal_failure — Task 12 + tests in Task 11 ✓
   - §7.6 eventId via workflow.uuid4 — Task 10 + test in Task 9 (seq monotonicity is a proxy) ✓
   - §9 config — Task 3 ✓
2. **Placeholder scan:** every step has full code or full command output. The phrase "TBD" / "TODO" does not appear. The one place that says "if TS complains" (Task 10 Step 6) gives the exact fix.
3. **Type consistency:**
   - `TurnInput` introduced in Task 2, used in Tasks 10, 11, 13. Same shape everywhere.
   - `userInputSignal`, `stageQuery`, `queueDepthQuery` declared in Task 4, imported in Tasks 10, 12, 13. Identical names everywhere.
   - `sendProgressEvent` declared in Task 7, imported in Tasks 10, 12. Same signature.
   - `orchestratorWorkflow(sessionId: string)` declared in Task 12, called in Task 13's `startSession`. Same arity.
   - `turnWorkflow(input: TurnInput)` declared in Task 10, called in Task 12's `executeChild` and in Task 13's `startTurn`. Same arity.
   - The barrel `src/workflows/index.ts` (Task 12 Step 2) exports exactly the names imported elsewhere.
4. **Out-of-scope creep:** no tb-streamer files modified. No new infra (Postgres, Redis). Mock receiver is a smoke-only script, not the real integration target. ✓

---

## Hand-off

When this plan finishes:

- Plan 3 (tb-streamer wiring) can implement the real webhook receiver and verify against this worker by swapping out `npm run smoke:receiver` for the real tb-streamer process. The wire contract is locked in by `@threadbase/agent-types`.
- Operators can run multi-agent smoke sessions today against the mock receiver. The Temporal UI shows the full session/turn topology.
- The legacy single-turn smoke (`smoke:task`) is preserved as a fallback when only the pipeline (not the orchestrator) is being debugged.
