# Plan 3 — tb-streamer Wiring (Webhook Receiver, Agent Client, Mode Flag, JSONL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire tb-streamer into the multi-agent pipeline built in Plans 1 and 2. Adds the **`--multi-agent-flow` mode flag**, the **signed-HMAC webhook receiver** that drops the worker's progress events into the WebSocket hub, the **per-session in-memory dedupe map**, the **Temporal agent client** that starts orchestrator sessions and signals user input, and the **JSONL writer** that persists assistant turns when their final `agent_output` arrives.

**Architecture:** All changes are tb-streamer-internal except for two things both processes share: the `@threadbase/agent-types` package (consumed via a local `file:` dep into `vendor/agent-types`) and the `PROGRESS_HMAC_SECRET`. The webhook route follows the established `/api/__update` pattern (public-bypass list + HMAC handler-side verification). Dedupe state hangs off the existing `ManagedSession` record. WebSocket emission goes through the existing `WSHub.broadcast` channel using two additive `WSMessage` shapes — existing mobile clients keep working.

**Tech Stack:** TypeScript 5.5+ (ESM), Hono 4 (existing API stack), `@hono/node-server` + `@hono/node-ws`, `ws` 8, `@temporalio/client` 1.11 (new), `@threadbase/agent-types` from Plan 1, vitest + Biome (existing).

---

## Scope

Plan 3 ships ONLY the tb-streamer-side changes. It does NOT:

- Modify the tb-multi-agent worker, workflows, or activities (those landed in Plan 2).
- Run a real Temporal server or Anthropic key in tests — the integration smoke is a manual procedure documented at the end.
- Change the mobile-pinned API surface beyond the **additive** new fields documented in spec §5.2.
- Touch any code path used by PTY mode when `MULTI_AGENT_FLOW` is OFF. PTY mode keeps working exactly as before.

This plan is shippable on its own: at the end, a tb-streamer process with `--multi-agent-flow` set can start an orchestrator session over its existing WebSocket protocol, forward signed progress events to subscribers, dedupe replays, and persist assistant turns to JSONL — all verifiable against the mock-receiver-equivalent worker built in Plan 2.

---

## File Structure

All paths relative to the tb-streamer repo root.

| Path | Purpose |
|---|---|
| `package.json` (MODIFY) | Add `@temporalio/client` dependency. Add `@threadbase/agent-types` as a local `file:` dep. Add `MULTI_AGENT_FLOW` description to env-var docs (README-side only — no script change). |
| `vendor/agent-types/` (NEW symlink-or-copy) | Local target of the `file:` dep. Mirrors Plan 1's package via either a symlink to the sibling repo (dev) or a copied snapshot (CI). |
| `src/agent/types.ts` (NEW) | Re-export of `@threadbase/agent-types` plus tb-streamer-local helper types. Single import surface for the rest of the codebase. |
| `src/agent/agent-config.ts` (NEW) | Reads `MULTI_AGENT_FLOW`, `PROGRESS_HMAC_SECRET`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` from env. Single source of truth for agent-mode runtime config. |
| `src/agent/agent-client.ts` (NEW) | Thin Temporal client wrapper. `startSession`, `sendUserInput`, `endSession`, `getSessionStage`. Lazy-connects on first use. Used by both the WebSocket message handler (to start sessions / signal turns) and the smoke-test scripts. |
| `src/agent/dedupe.ts` (NEW) | Bounded LRU implementation for the per-session `progressDedupeIds`. Used by the webhook receiver to drop replays. |
| `src/agent/conversation-writer.ts` (NEW) | Writes assistant turns to JSONL when the final `agent_output` arrives. Reuses the canonical conversation directory already known to `ConversationCache`. |
| `src/api/routes/progress.routes.ts` (NEW) | Hono route at `POST /internal/sessions/:sessionId/progress`. Verifies HMAC, dedupes by `eventId`, calls `WSHub.broadcast`, calls `conversationWriter.write` on terminal `agent_output`. |
| `src/api/middleware/auth.middleware.ts` (MODIFY) | Add `/internal/sessions/...` to the public-POST bypass list (HMAC auth is handled inside the route, mirroring `/api/__update`). |
| `src/api/app.ts` (MODIFY) | Mount the new `createProgressRoutes(deps)` factory at `/internal`. |
| `src/api/types/api-deps.ts` (MODIFY) | Add `agentClient: AgentClient | null`, `agentConfig: AgentConfig`, `conversationWriter: ConversationWriter | null` to `ApiDeps`. Null when not in multi-agent mode. |
| `src/server.ts` (MODIFY) | When `MULTI_AGENT_FLOW` is ON, construct `AgentClient` + `ConversationWriter` and inject into `ApiDeps`. PTY-mode code path unchanged. |
| `src/session-store.ts` (MODIFY) | Extend `ManagedSession` (in `src/types.ts`) with `progressDedupeIds?: LRU`. `addManaged` initializes it when the session is created in multi-agent mode. |
| `src/types.ts` (MODIFY) | Add the new `WSMessage` variants `agent_output` and the additive fields on `session_update` (`stage`, `stalledSinceMs`, `reworkAttempt`). Re-export `Stage` from agent-types for convenience. |
| `src/ws-hub.ts` (MODIFY) | No behavioral change — `broadcast` already takes a `WSMessage`. Tests now cover the new variants. |
| `cli/index.ts` (MODIFY) | Add `--multi-agent-flow` flag. Sets `MULTI_AGENT_FLOW=true` in `process.env` before `server.ts` reads it. |
| `__tests__/agent/dedupe.test.ts` (NEW) | LRU dedupe behavior. |
| `__tests__/agent/progress-route.test.ts` (NEW) | Webhook receiver: bad signature 401, good signature 200, dedupe 200, broadcast happens, JSONL write happens on terminal agent_output. |
| `__tests__/agent/agent-client.test.ts` (NEW) | Client uses `workflowIdReusePolicy: REJECT_DUPLICATE` for `startSession`. Signal call uses the right signal id. |
| `__tests__/agent/conversation-writer.test.ts` (NEW) | Writes a well-formed JSONL line, appends correctly, handles missing directory. |
| `docs/multi-agent-mode.md` (NEW) | One-page operator guide: env vars, ports, how to start the worker + streamer together, how to verify. |

Why these splits:

- All new code lives under `src/agent/` so the multi-agent surface is one directory you can grep, review, and (when ready) extract into its own module.
- The route under `src/api/routes/` follows the existing `*.routes.ts` convention; the new factory takes `ApiDeps` the same way every other route does.
- `ApiDeps` keeps the multi-agent fields nullable so PTY mode does not pay for them. Every consumer checks `agentClient != null` before using it.

---

## Tasks

### Task 1: Wire `@threadbase/agent-types` as a local file dep

**Files:**
- Modify: `package.json`
- Create: symlink at `vendor/agent-types/` pointing at the sibling tb-multi-agent repo's `packages/agent-types`

This mirrors how `@threadbase/scanner` is wired today (`file:vendor/scanner`) per tb-streamer's CLAUDE.md.

- [ ] **Step 1: Confirm the sibling repo is at the expected path**

Run from the tb-streamer repo root:

```bash
ls ../tb-multi-agent/packages/agent-types/package.json
```

Expected: file exists. If not, stop and resolve the path before continuing — the rest of this task depends on it.

- [ ] **Step 2: Create the vendor symlink**

```bash
mkdir -p vendor
ln -s ../tb-multi-agent/packages/agent-types vendor/agent-types
ls -la vendor
```

Expected: `vendor/agent-types -> ../tb-multi-agent/packages/agent-types`.

Notes for non-dev environments:
- CI is unlikely to have a sibling checkout. The repo's existing pattern for `vendor/scanner` is a git submodule. For milestone B, agent-types is published OUT of tb-multi-agent's repo, so the submodule approach is deferred (see `tb-multi-agent/docs/ROADMAP.md`). CI is OUT of scope for this task; integration smoke is local-only.
- A copy (instead of a symlink) would work too, but it drifts. Stick with the symlink for dev; revisit when stage 2 of the package distribution lands.

- [ ] **Step 3: Build the package once so `dist/` exists**

```bash
( cd vendor/agent-types && npm install && npm run build )
ls vendor/agent-types/dist
```

Expected: `dist/` contains `index.js`, `index.d.ts`, and the four sibling modules per Plan 1's Task 13 output. If it doesn't, run Plan 1 first.

- [ ] **Step 4: Add the dependency to `package.json`**

Edit `package.json`. Inside the `dependencies` block, add:

```json
    "@threadbase/agent-types": "file:vendor/agent-types",
    "@temporalio/client": "^1.11.0",
```

Place them in alphabetical order to match the existing style (e.g. between `@hono/node-ws` and `@threadbase/scanner`).

- [ ] **Step 5: Install**

```bash
npm install
```

Expected: npm resolves the local file dep and the new Temporal client. `package-lock.json` updates.

- [ ] **Step 6: Verify the import works**

Run a one-shot script:

```bash
npx tsx -e "import('@threadbase/agent-types').then(m => console.log(m.STAGES))"
```

Expected:

```
[
  'thinking', 'queued', 'processing',
  'review',   'rework', 'sign-off',
  'done'
]
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vendor/agent-types
git commit -m "build(agent-types): add as local file dep alongside scanner"
```

---

### Task 2: Add agent runtime config module

**Files:**
- Create: `src/agent/agent-config.ts`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p src/agent
```

- [ ] **Step 2: Write `src/agent/agent-config.ts`**

```ts
// src/agent/agent-config.ts
//
// Runtime config for multi-agent mode. Read once at server startup so we don't
// thread env-var lookups through the rest of the codebase.

export interface AgentConfig {
  enabled: boolean;
  temporal: {
    address: string;
    namespace: string;
    taskQueue: string;
  };
  webhook: {
    hmacSecret: string;
    timestampSkewSeconds: number;
  };
  dedupe: {
    perSessionCapacity: number;
  };
  conversationsDir: string;
}

const DEFAULTS = {
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "agent-tasks",
  PROGRESS_HMAC_SECRET: "dev-secret-change-me",
  PROGRESS_WEBHOOK_TIMESTAMP_SKEW_SECONDS: "300",
  PROGRESS_DEDUPE_CAPACITY: "1024",
};

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const enabled = isTruthy(env.MULTI_AGENT_FLOW);
  return {
    enabled,
    temporal: {
      address: env.TEMPORAL_ADDRESS ?? DEFAULTS.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE ?? DEFAULTS.TEMPORAL_NAMESPACE,
      taskQueue: env.TEMPORAL_TASK_QUEUE ?? DEFAULTS.TEMPORAL_TASK_QUEUE,
    },
    webhook: {
      hmacSecret: env.PROGRESS_HMAC_SECRET ?? DEFAULTS.PROGRESS_HMAC_SECRET,
      timestampSkewSeconds: Number(
        env.PROGRESS_WEBHOOK_TIMESTAMP_SKEW_SECONDS ??
        DEFAULTS.PROGRESS_WEBHOOK_TIMESTAMP_SKEW_SECONDS,
      ),
    },
    dedupe: {
      perSessionCapacity: Number(
        env.PROGRESS_DEDUPE_CAPACITY ?? DEFAULTS.PROGRESS_DEDUPE_CAPACITY,
      ),
    },
    // Mirrors ServerConfig.cacheDir's parent — the actual JSONL directory.
    // We read it from env here; the conversation writer takes the resolved
    // value from ServerConfig in Task 9.
    conversationsDir: env.THREADBASE_CONVERSATIONS_DIR ?? "",
  };
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run lint
```

Expected: `lint` (which runs `tsc --noEmit && biome check .`) passes. The file isn't imported yet — biome may flag unused exports; if so, ignore for now (next tasks import it).

- [ ] **Step 4: Commit**

```bash
git add src/agent/agent-config.ts
git commit -m "feat(agent): add multi-agent runtime config"
```

---

### Task 3: Per-session dedupe LRU — failing test

**Files:**
- Create: `__tests__/agent/dedupe.test.ts`

- [ ] **Step 1: Create the test directory**

```bash
mkdir -p __tests__/agent
```

- [ ] **Step 2: Write the failing test**

```ts
// __tests__/agent/dedupe.test.ts
import { describe, expect, it } from "vitest";
import { createProgressDedupeLRU, type ProgressDedupeLRU } from "../../src/agent/dedupe";

describe("ProgressDedupeLRU", () => {
  it("returns false the first time an id is seen, true thereafter", () => {
    const lru: ProgressDedupeLRU = createProgressDedupeLRU(8);
    expect(lru.hasSeen("evt-1")).toBe(false);
    expect(lru.hasSeen("evt-1")).toBe(true);
  });

  it("treats different ids independently", () => {
    const lru = createProgressDedupeLRU(8);
    expect(lru.hasSeen("evt-A")).toBe(false);
    expect(lru.hasSeen("evt-B")).toBe(false);
    expect(lru.hasSeen("evt-A")).toBe(true);
    expect(lru.hasSeen("evt-B")).toBe(true);
  });

  it("evicts oldest ids once capacity is exceeded", () => {
    const lru = createProgressDedupeLRU(3);
    expect(lru.hasSeen("a")).toBe(false);
    expect(lru.hasSeen("b")).toBe(false);
    expect(lru.hasSeen("c")).toBe(false);
    expect(lru.hasSeen("d")).toBe(false); // evicts "a"
    // "a" was evicted; first sighting again returns false.
    expect(lru.hasSeen("a")).toBe(false);
    // "b", "c", "d" still remembered.
    expect(lru.hasSeen("b")).toBe(true);
    expect(lru.hasSeen("c")).toBe(true);
    expect(lru.hasSeen("d")).toBe(true);
  });

  it("treats a re-seen id as a hit AND refreshes its recency", () => {
    const lru = createProgressDedupeLRU(3);
    lru.hasSeen("a"); // false
    lru.hasSeen("b"); // false
    lru.hasSeen("c"); // false
    expect(lru.hasSeen("a")).toBe(true); // refreshes a's recency
    lru.hasSeen("d"); // evicts the now-oldest, which is "b"
    expect(lru.hasSeen("b")).toBe(false); // "b" evicted, fresh sighting
    expect(lru.hasSeen("a")).toBe(true);  // still cached
  });

  it("reports its current size", () => {
    const lru = createProgressDedupeLRU(4);
    expect(lru.size).toBe(0);
    lru.hasSeen("a");
    lru.hasSeen("b");
    expect(lru.size).toBe(2);
    lru.hasSeen("a"); // dup — size unchanged
    expect(lru.size).toBe(2);
  });

  it("throws on capacity < 1", () => {
    expect(() => createProgressDedupeLRU(0)).toThrow();
    expect(() => createProgressDedupeLRU(-3)).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run __tests__/agent/dedupe.test.ts
```

Expected: FAIL with `Failed to resolve import '../../src/agent/dedupe'`.

---

### Task 4: Per-session dedupe LRU — implementation

**Files:**
- Create: `src/agent/dedupe.ts`

- [ ] **Step 1: Write the LRU**

```ts
// src/agent/dedupe.ts
//
// Bounded LRU for per-session progress-event dedupe. Implementation uses the
// fact that Map iterates in insertion order — re-inserting a key moves it to
// the end, which is exactly LRU semantics with no extra bookkeeping.
//
// Spec §7.1: this is the milestone-B dedupe. The map lives on the session
// record and dies with the session. Postgres-backed durability is option D,
// deferred — see tb-multi-agent docs/plans/postgres-dedupe.md.

export interface ProgressDedupeLRU {
  hasSeen(eventId: string): boolean;
  readonly size: number;
}

export function createProgressDedupeLRU(capacity: number): ProgressDedupeLRU {
  if (!Number.isFinite(capacity) || capacity < 1) {
    throw new Error(`dedupe LRU capacity must be >= 1, got ${capacity}`);
  }
  const map = new Map<string, true>();

  return {
    hasSeen(eventId: string): boolean {
      if (map.has(eventId)) {
        // Refresh recency: remove + reinsert moves to most-recent position.
        map.delete(eventId);
        map.set(eventId, true);
        return true;
      }
      map.set(eventId, true);
      if (map.size > capacity) {
        // Evict the oldest entry (the first key in insertion order).
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      return false;
    },
    get size(): number {
      return map.size;
    },
  };
}
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
npx vitest run __tests__/agent/dedupe.test.ts
```

Expected: PASS, 6 tests green.

- [ ] **Step 3: Commit**

```bash
git add src/agent/dedupe.ts __tests__/agent/dedupe.test.ts
git commit -m "feat(agent): add bounded LRU for progress dedupe"
```

---

### Task 5: Extend ManagedSession + types with multi-agent additions

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Read the existing types file**

```bash
wc -l src/types.ts
```

Note the line count so the diff stays focused. (Typical: 200-400 lines.)

- [ ] **Step 2: Add the agent-mode imports near the top of `src/types.ts`**

Find the block of existing type imports (or, if there are none, the first non-comment line). Add:

```ts
import type { Stage } from "@threadbase/agent-types";
import type { ProgressDedupeLRU } from "./agent/dedupe";
```

- [ ] **Step 3: Extend `ManagedSession`**

Locate the `ManagedSession` interface. It currently looks something like (your file may have additional fields — leave them as-is):

```ts
export interface ManagedSession {
  id: string;
  status: "running" | "waiting_input" | "completed" | "failed" | "on_hold";
  // ... other existing fields ...
}
```

Add the following optional fields at the end of the interface body (do not remove or reorder existing ones):

```ts
  /**
   * Multi-agent mode only. Per-session in-memory LRU of progress event ids
   * seen by the webhook receiver. Used to drop Temporal-replay duplicates
   * before they reach the WebSocket. See spec §7.1.
   */
  progressDedupeIds?: ProgressDedupeLRU;

  /** Multi-agent: current stage of the active turn (advisory; advisory wire field). */
  stage?: Stage | string;

  /** Multi-agent: ms since the session last emitted a stage transition. */
  stalledSinceMs?: number;

  /** Multi-agent: 1 or 2 when stage === "rework". */
  reworkAttempt?: number;
```

- [ ] **Step 4: Add new `WSMessage` variants**

Locate the `WSMessage` union (or type alias). Add two new variants by extending the union:

```ts
// New: per-step output block from any agent. Additive — existing mobile
// clients ignore this type, new clients render it as a chat block.
| {
    type: "agent_output";
    sessionId: string;
    turnId: string;
    role: "worker" | "reviewer" | "signoff";
    content: string;
    partial?: boolean;
    reviewerOverruled?: boolean;
    stage?: Stage | string;
    reworkAttempt?: number;
  }
// New: terminal failure for a single turn (session itself keeps running).
| {
    type: "turn_failure";
    sessionId: string;
    turnId: string;
    reason: string;
  }
```

If `WSMessage` is defined as a union of separate exported interfaces rather than inline variants, add two new exported interfaces and append them to the union.

Also extend the existing `session_update` variant (find it in the union — its `type` field is `"session_update"`) to allow the new optional fields. Add (DO NOT remove existing fields):

```ts
  stage?: Stage | string;
  stalledSinceMs?: number;
  reworkAttempt?: number;
```

- [ ] **Step 5: Typecheck**

```bash
npm run lint
```

Expected: passes. If TS complains about the import of `ProgressDedupeLRU` because `src/agent/dedupe.ts` exports it as a type — verify the export is `export interface`, which is both type and value. It is, per Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add stage and agent_output fields"
```

---

### Task 6: Update SessionStore to wire dedupe per session

**Files:**
- Modify: `src/session-store.ts`

- [ ] **Step 1: Open `src/session-store.ts`** and locate `addManaged`.

- [ ] **Step 2: Add a small import**

At the top of the file, alongside the existing type imports:

```ts
import { createProgressDedupeLRU } from "./agent/dedupe";
```

- [ ] **Step 3: Add an opt-in init method**

Below `addManaged`, add:

```ts
  /**
   * Multi-agent mode only. Attach a dedupe LRU to a session record. Idempotent —
   * calling twice keeps the existing LRU (and its contents).
   */
  initAgentSession(sessionId: string, dedupeCapacity: number): void {
    const session = this.managed.get(sessionId);
    if (!session) return;
    if (session.progressDedupeIds) return;
    session.progressDedupeIds = createProgressDedupeLRU(dedupeCapacity);
  }
```

We do NOT modify `addManaged` itself because the existing PTY code path constructs `ManagedSession` records without knowing about agent mode. The mode-aware code (Task 11) calls `addManaged` + `initAgentSession` together.

- [ ] **Step 4: Typecheck**

```bash
npm run lint
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/session-store.ts
git commit -m "feat(session-store): add initAgentSession for dedupe wiring"
```

---

### Task 7: Conversation writer — failing test

**Files:**
- Create: `__tests__/agent/conversation-writer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/agent/conversation-writer.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationWriter, type ConversationWriter } from "../../src/agent/conversation-writer";

describe("ConversationWriter", () => {
  let dir: string;
  let writer: ConversationWriter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tb-jsonl-"));
    writer = createConversationWriter({ baseDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a JSON line per assistant turn", async () => {
    await writer.appendAssistantTurn({
      sessionId: "sess_1",
      turnId: "turn_1",
      content: "hello world",
    });
    const file = join(dir, "sess_1.jsonl");
    const text = await readFile(file, "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(text.trim());
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toBe("hello world");
    expect(parsed.turnId).toBe("turn_1");
    expect(typeof parsed.timestamp).toBe("number");
  });

  it("appends multiple turns to the same file", async () => {
    await writer.appendAssistantTurn({ sessionId: "sess_2", turnId: "t1", content: "a" });
    await writer.appendAssistantTurn({ sessionId: "sess_2", turnId: "t2", content: "b" });
    const text = await readFile(join(dir, "sess_2.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).turnId).toBe("t1");
    expect(JSON.parse(lines[1]).turnId).toBe("t2");
  });

  it("carries reviewerOverruled when set", async () => {
    await writer.appendAssistantTurn({
      sessionId: "sess_3",
      turnId: "t",
      content: "answer",
      reviewerOverruled: true,
    });
    const parsed = JSON.parse(
      (await readFile(join(dir, "sess_3.jsonl"), "utf8")).trim(),
    );
    expect(parsed.reviewerOverruled).toBe(true);
  });

  it("creates the directory if it does not exist", async () => {
    const nested = join(dir, "deep", "nest");
    const w = createConversationWriter({ baseDir: nested });
    await w.appendAssistantTurn({ sessionId: "x", turnId: "y", content: "z" });
    const s = await stat(join(nested, "x.jsonl"));
    expect(s.isFile()).toBe(true);
  });

  it("escapes newlines and quotes safely", async () => {
    await writer.appendAssistantTurn({
      sessionId: "sess_e",
      turnId: "t",
      content: 'has "quotes"\nand a newline',
    });
    const text = await readFile(join(dir, "sess_e.jsonl"), "utf8");
    // The file must still be valid JSONL — one line, one JSON object.
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.content).toContain("newline");
  });

  it("rejects an empty content with a clear error (do not write empty assistant turns)", async () => {
    await expect(
      writer.appendAssistantTurn({ sessionId: "s", turnId: "t", content: "" }),
    ).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run __tests__/agent/conversation-writer.test.ts
```

Expected: FAIL with `Failed to resolve import '../../src/agent/conversation-writer'`.

---

### Task 8: Conversation writer — implementation

**Files:**
- Create: `src/agent/conversation-writer.ts`

- [ ] **Step 1: Write the file**

```ts
// src/agent/conversation-writer.ts
//
// Persists assistant turns to JSONL when the worker's final agent_output for a
// turn arrives. The existing ConversationCache + ConversationWatcher then
// ingest the line via the existing watcher pipeline — see spec §6.3.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AppendArgs {
  sessionId: string;
  turnId: string;
  content: string;
  reviewerOverruled?: boolean;
}

export interface ConversationWriter {
  appendAssistantTurn(args: AppendArgs): Promise<void>;
}

export function createConversationWriter(opts: { baseDir: string }): ConversationWriter {
  const { baseDir } = opts;

  return {
    async appendAssistantTurn(args: AppendArgs): Promise<void> {
      if (!args.content || args.content.length === 0) {
        throw new Error("ConversationWriter: refusing to write empty assistant turn");
      }
      const file = join(baseDir, `${args.sessionId}.jsonl`);
      await mkdir(dirname(file), { recursive: true });

      const record = {
        role: "assistant" as const,
        turnId: args.turnId,
        content: args.content,
        timestamp: Date.now(),
        ...(args.reviewerOverruled ? { reviewerOverruled: true } : {}),
      };

      const line = `${JSON.stringify(record)}\n`;
      await appendFile(file, line, { encoding: "utf8" });
    },
  };
}
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
npx vitest run __tests__/agent/conversation-writer.test.ts
```

Expected: PASS, 6 tests green.

- [ ] **Step 3: Commit**

```bash
git add src/agent/conversation-writer.ts __tests__/agent/conversation-writer.test.ts
git commit -m "feat(agent): persist assistant turns to JSONL"
```

---

### Task 9: Agent client — failing test

**Files:**
- Create: `__tests__/agent/agent-client.test.ts`

- [ ] **Step 1: Write the failing test**

The Temporal client's API surface is straightforward to mock — we don't need a real Temporal server for unit tests. The test injects a fake `Client` and verifies our wrapper calls the right methods with the right args.

```ts
// __tests__/agent/agent-client.test.ts
import { describe, expect, it, vi } from "vitest";
import type { UserInputSignal } from "@threadbase/agent-types";
import { createAgentClient } from "../../src/agent/agent-client";

function makeFakeTemporalClient() {
  const start = vi.fn(async (_wf: unknown, opts: any) => ({ workflowId: opts.workflowId }));
  const signal = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const query = vi.fn(async () => "idle");

  const handle = { signal, cancel, query };

  return {
    workflow: {
      start,
      getHandle: vi.fn(() => handle),
    },
    __spies: { start, signal, cancel, query, getHandle: undefined as undefined },
  };
}

describe("AgentClient", () => {
  it("startSession uses session-<id> as the workflowId and REJECT_DUPLICATE reuse policy", async () => {
    const fake = makeFakeTemporalClient();
    const client = createAgentClient({
      temporalClient: fake as any,
      taskQueue: "agent-tasks",
    });

    const wfId = await client.startSession("sess_abc");
    expect(wfId).toBe("session-sess_abc");

    const callArgs = fake.workflow.start.mock.calls[0]?.[1];
    expect(callArgs.workflowId).toBe("session-sess_abc");
    expect(callArgs.taskQueue).toBe("agent-tasks");
    expect(callArgs.args).toEqual(["sess_abc"]);
    expect(callArgs.workflowIdReusePolicy).toBe("REJECT_DUPLICATE");
  });

  it("sendUserInput signals the right handle with the userInput payload", async () => {
    const fake = makeFakeTemporalClient();
    const client = createAgentClient({ temporalClient: fake as any, taskQueue: "x" });
    await client.startSession("sess_signal");

    const payload: UserInputSignal = {
      turnId: "turn-x",
      prompt: "hello",
      conversationHistory: [],
    };
    await client.sendUserInput("sess_signal", payload);

    expect(fake.workflow.getHandle).toHaveBeenCalledWith("session-sess_signal");
    // The signal call should pass an object whose .name is 'userInput' and
    // the payload as a single arg.
    const sigCall = (fake as any).workflow.getHandle().signal.mock.calls[0];
    expect(sigCall[0].name).toBe("userInput");
    expect(sigCall[1]).toEqual(payload);
  });

  it("endSession cancels the orchestrator handle", async () => {
    const fake = makeFakeTemporalClient();
    const client = createAgentClient({ temporalClient: fake as any, taskQueue: "x" });
    await client.startSession("sess_end");
    await client.endSession("sess_end");
    expect((fake as any).workflow.getHandle().cancel).toHaveBeenCalled();
  });

  it("getSessionStage queries the orchestrator's stageQuery", async () => {
    const fake = makeFakeTemporalClient();
    const client = createAgentClient({ temporalClient: fake as any, taskQueue: "x" });
    await client.startSession("sess_q");
    await client.getSessionStage("sess_q");
    const qCall = (fake as any).workflow.getHandle().query.mock.calls[0];
    expect(qCall[0].name).toBe("stage");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run __tests__/agent/agent-client.test.ts
```

Expected: FAIL with `Failed to resolve import '../../src/agent/agent-client'`.

---

### Task 10: Agent client — implementation

**Files:**
- Create: `src/agent/agent-client.ts`

- [ ] **Step 1: Write the client**

We define our OWN `userInputSignal` and `stageQuery` identities locally so we don't have to import from tb-multi-agent (the two repos stay loose-coupled). Temporal matches signals/queries by their `.name` field — see spec §5.3.

```ts
// src/agent/agent-client.ts
//
// Thin Temporal client wrapper used by tb-streamer in multi-agent mode.
// Does NOT import workflow code from tb-multi-agent — we identify the
// workflow and its signals/queries by name. The workflow's wire contract
// lives in @threadbase/agent-types.

import type { Client } from "@temporalio/client";
import { defineQuery, defineSignal } from "@temporalio/client";
import type { UserInputSignal } from "@threadbase/agent-types";

// Same identifiers as tb-multi-agent's src/workflows/signals.ts.
// Temporal matches by name; the typed wrappers are just for ergonomics.
const userInputSignal = defineSignal<[UserInputSignal]>("userInput");
const stageQuery = defineQuery<string>("stage");

const ORCHESTRATOR_WORKFLOW_TYPE = "orchestratorWorkflow";

export interface AgentClient {
  startSession(sessionId: string): Promise<string>;
  sendUserInput(sessionId: string, payload: UserInputSignal): Promise<void>;
  endSession(sessionId: string): Promise<void>;
  getSessionStage(sessionId: string): Promise<string>;
}

export interface AgentClientOpts {
  temporalClient: Client;
  taskQueue: string;
}

const sessionWorkflowId = (sessionId: string): string => `session-${sessionId}`;

export function createAgentClient({ temporalClient, taskQueue }: AgentClientOpts): AgentClient {
  return {
    async startSession(sessionId: string): Promise<string> {
      const handle = await temporalClient.workflow.start(ORCHESTRATOR_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: sessionWorkflowId(sessionId),
        args: [sessionId],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
      return handle.workflowId;
    },
    async sendUserInput(sessionId: string, payload: UserInputSignal): Promise<void> {
      await temporalClient.workflow.getHandle(sessionWorkflowId(sessionId)).signal(userInputSignal, payload);
    },
    async endSession(sessionId: string): Promise<void> {
      await temporalClient.workflow.getHandle(sessionWorkflowId(sessionId)).cancel();
    },
    async getSessionStage(sessionId: string): Promise<string> {
      return temporalClient.workflow.getHandle(sessionWorkflowId(sessionId)).query(stageQuery);
    },
  };
}
```

A note on `defineSignal` / `defineQuery` import path: in `@temporalio/client`, these are re-exported from `@temporalio/common` and are available as named exports on the client package. If TypeScript complains that they aren't exported from `@temporalio/client`, swap the import to `@temporalio/common`:

```ts
import { defineQuery, defineSignal } from "@temporalio/common";
```

`@temporalio/common` is a transitive dep of `@temporalio/client` and does not need to be in `package.json`.

- [ ] **Step 2: Run the test to verify it passes**

```bash
npx vitest run __tests__/agent/agent-client.test.ts
```

Expected: PASS, 4 tests green.

- [ ] **Step 3: Commit**

```bash
git add src/agent/agent-client.ts __tests__/agent/agent-client.test.ts
git commit -m "feat(agent): Temporal client wrapper for session API"
```

---

### Task 11: Webhook receiver — failing test

**Files:**
- Create: `__tests__/agent/progress-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/agent/progress-route.test.ts
import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { Hono } from "hono";
import type { ProgressEvent } from "@threadbase/agent-types";
import { createProgressRoutes } from "../../src/api/routes/progress.routes";
import { createProgressDedupeLRU } from "../../src/agent/dedupe";

const SECRET = "unit-secret";

function makeDeps(overrides: Partial<{
  broadcastSpy: ReturnType<typeof vi.fn>;
  writeSpy: ReturnType<typeof vi.fn>;
  dedupe: ReturnType<typeof createProgressDedupeLRU>;
}> = {}) {
  const broadcastSpy = overrides.broadcastSpy ?? vi.fn();
  const writeSpy = overrides.writeSpy ?? vi.fn(async () => undefined);
  const dedupe = overrides.dedupe ?? createProgressDedupeLRU(64);

  const wsHub = { broadcast: broadcastSpy };
  const sessionStore = {
    getManaged: vi.fn(() => ({
      id: "sess_t",
      status: "running",
      progressDedupeIds: dedupe,
    })),
  };
  const conversationWriter = { appendAssistantTurn: writeSpy };
  const agentConfig = {
    enabled: true,
    webhook: { hmacSecret: SECRET, timestampSkewSeconds: 300 },
    dedupe: { perSessionCapacity: 64 },
    temporal: { address: "x", namespace: "x", taskQueue: "x" },
    conversationsDir: "",
  };

  return { wsHub, sessionStore, conversationWriter, agentConfig, broadcastSpy, writeSpy };
}

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function makeApp(deps: ReturnType<typeof makeDeps>) {
  const app = new Hono();
  app.route("/internal", createProgressRoutes(deps as any));
  return app;
}

function event(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    sessionId: "sess_t",
    turnId: "turn_t",
    eventId: "evt_1",
    seq: 0,
    type: "stage_transition",
    stage: "processing",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

async function post(app: Hono, body: ProgressEvent, sig: string): Promise<Response> {
  return app.request(`/internal/sessions/${body.sessionId}/progress`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-progress-signature": sig,
      "x-progress-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-progress-event-id": body.eventId,
    },
    body: JSON.stringify(body),
  });
}

describe("progress route", () => {
  it("rejects requests with a missing signature with 401", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const res = await post(app, event(), "");
    expect(res.status).toBe(401);
    expect(deps.broadcastSpy).not.toHaveBeenCalled();
  });

  it("rejects requests with a bad signature with 401", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event();
    const res = await post(app, body, "deadbeef".repeat(8));
    expect(res.status).toBe(401);
    expect(deps.broadcastSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid signature and broadcasts to the WSHub", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_ok" });
    const raw = JSON.stringify(body);
    const res = await post(app, body, sign(raw, SECRET));
    expect(res.status).toBe(200);
    expect(deps.broadcastSpy).toHaveBeenCalledTimes(1);
    const msg = deps.broadcastSpy.mock.calls[0][0];
    expect(msg.type).toBe("session_update");
    expect(msg.sessionId).toBe("sess_t");
    expect(msg.stage).toBe("processing");
  });

  it("dedupes a repeated eventId — second POST returns 200 deduped:true and does NOT broadcast", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({ eventId: "evt_dup" });
    const raw = JSON.stringify(body);
    const sig = sign(raw, SECRET);

    const r1 = await post(app, body, sig);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });

    const r2 = await post(app, body, sig);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true, deduped: true });
    expect(deps.broadcastSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards an agent_output event as an agent_output WSMessage", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({
      eventId: "evt_out",
      type: "agent_output",
      stage: "processing",
      payload: { content: "draft text" },
    });
    const res = await post(app, body, sign(JSON.stringify(body), SECRET));
    expect(res.status).toBe(200);
    const msg = deps.broadcastSpy.mock.calls[0][0];
    expect(msg.type).toBe("agent_output");
    expect(msg.content).toBe("draft text");
    expect(msg.role).toBe("worker");
  });

  it("writes the JSONL line on a FINAL agent_output (stage === 'done')", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({
      eventId: "evt_done",
      type: "agent_output",
      stage: "done",
      payload: { content: "the final answer", reviewerOverruled: true },
    });
    const res = await post(app, body, sign(JSON.stringify(body), SECRET));
    expect(res.status).toBe(200);
    expect(deps.writeSpy).toHaveBeenCalledTimes(1);
    expect(deps.writeSpy.mock.calls[0][0]).toEqual({
      sessionId: "sess_t",
      turnId: "turn_t",
      content: "the final answer",
      reviewerOverruled: true,
    });
  });

  it("forwards a terminal_failure event as a turn_failure WSMessage but does NOT write JSONL", async () => {
    const deps = makeDeps();
    const app = makeApp(deps);
    const body = event({
      eventId: "evt_fail",
      type: "terminal_failure",
      payload: { reason: "activity exhausted retries" },
    });
    const res = await post(app, body, sign(JSON.stringify(body), SECRET));
    expect(res.status).toBe(200);
    const msg = deps.broadcastSpy.mock.calls[0][0];
    expect(msg.type).toBe("turn_failure");
    expect(msg.reason).toBe("activity exhausted retries");
    expect(deps.writeSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is unknown", async () => {
    const deps = makeDeps();
    (deps.sessionStore.getManaged as any).mockReturnValueOnce(null);
    const app = makeApp(deps);
    const body = event();
    const res = await post(app, body, sign(JSON.stringify(body), SECRET));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run __tests__/agent/progress-route.test.ts
```

Expected: FAIL with `Failed to resolve import '../../src/api/routes/progress.routes'`.

---

### Task 12: Webhook receiver — implementation

**Files:**
- Create: `src/api/routes/progress.routes.ts`

- [ ] **Step 1: Write the route**

```ts
// src/api/routes/progress.routes.ts
//
// Webhook receiver for worker → tb-streamer progress events.
//
// Auth: HMAC over the raw request body, header X-Progress-Signature.
// Auth bypass: the auth middleware skips this prefix because validation
// happens inside the handler (mirrors /api/__update).
//
// Idempotency: per-session LRU on the ManagedSession record. Duplicates
// return 200 with deduped:true and do not broadcast.

import { Hono } from "hono";
import crypto from "node:crypto";
import type { Stage, ProgressEvent, AgentOutputPayload } from "@threadbase/agent-types";
import type { AppEnv } from "../app";
import type { ApiDeps } from "../types/api-deps";
import type { WSMessage } from "../../types";

interface AgentDeps {
  sessionStore: {
    getManaged: (sessionId: string) => { id: string; progressDedupeIds?: { hasSeen: (id: string) => boolean } } | null;
  };
  wsHub: { broadcast: (m: WSMessage) => void };
  conversationWriter: { appendAssistantTurn: (a: { sessionId: string; turnId: string; content: string; reviewerOverruled?: boolean }) => Promise<void> } | null;
  agentConfig: {
    enabled: boolean;
    webhook: { hmacSecret: string; timestampSkewSeconds: number };
    dedupe: { perSessionCapacity: number };
  };
}

function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature || signature.length === 0) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function isWithinSkew(timestampHeader: string | undefined, skewSeconds: number): boolean {
  if (!timestampHeader) return true; // header optional in milestone B
  const t = Number(timestampHeader);
  if (!Number.isFinite(t)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - t) <= skewSeconds;
}

function stageToRole(stage: Stage | string | undefined): "worker" | "reviewer" | "signoff" {
  if (stage === "review") return "reviewer";
  if (stage === "sign-off") return "signoff";
  return "worker";
}

export const createProgressRoutes = (deps: ApiDeps & AgentDeps) => {
  const app = new Hono<AppEnv>();

  app.post("/sessions/:sessionId/progress", async (c) => {
    if (!deps.agentConfig.enabled) {
      return c.json({ error: "multi-agent mode not enabled" }, 404);
    }
    const sessionId = c.req.param("sessionId");
    const session = deps.sessionStore.getManaged(sessionId);
    if (!session) {
      return c.json({ error: "unknown session" }, 404);
    }

    const rawBuf = Buffer.from(await c.req.arrayBuffer());
    const sigHeader = c.req.header("x-progress-signature") ?? "";
    if (!verifySignature(rawBuf, sigHeader, deps.agentConfig.webhook.hmacSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!isWithinSkew(c.req.header("x-progress-timestamp"), deps.agentConfig.webhook.timestampSkewSeconds)) {
      return c.json({ error: "stale timestamp" }, 401);
    }

    let event: ProgressEvent;
    try {
      event = JSON.parse(rawBuf.toString("utf8")) as ProgressEvent;
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    if (!event.eventId || !event.sessionId || !event.turnId) {
      return c.json({ error: "missing required fields" }, 400);
    }

    // Dedupe (per spec §7.1). If the session lacks a dedupe map (e.g., it was
    // created in PTY mode and re-used), the receiver still works — every event
    // is treated as new.
    if (session.progressDedupeIds?.hasSeen(event.eventId)) {
      return c.json({ ok: true, deduped: true }, 200);
    }

    // ─── Translate to WSMessage and broadcast ───────────────────────────
    if (event.type === "stage_transition") {
      const msg: WSMessage = {
        type: "session_update",
        sessionId: event.sessionId,
        // Existing session_update consumers expect status; we leave it
        // undefined here (stage is the new-only field).
        stage: event.stage,
        reworkAttempt: event.reworkAttempt,
        stalledSinceMs: 0,
      } as WSMessage;
      deps.wsHub.broadcast(msg);
    } else if (event.type === "agent_output") {
      const payload = (event.payload ?? {}) as AgentOutputPayload;
      const msg: WSMessage = {
        type: "agent_output",
        sessionId: event.sessionId,
        turnId: event.turnId,
        role: stageToRole(event.stage),
        content: payload.content ?? "",
        partial: payload.partial,
        reviewerOverruled: payload.reviewerOverruled,
        stage: event.stage,
        reworkAttempt: event.reworkAttempt,
      } as WSMessage;
      deps.wsHub.broadcast(msg);

      // Persist final answer to JSONL.
      if (event.stage === "done" && deps.conversationWriter && payload.content) {
        await deps.conversationWriter.appendAssistantTurn({
          sessionId: event.sessionId,
          turnId: event.turnId,
          content: payload.content,
          reviewerOverruled: payload.reviewerOverruled,
        });
      }
    } else if (event.type === "terminal_failure") {
      const reason = (event.payload as { reason?: string } | undefined)?.reason ?? "unknown";
      const msg: WSMessage = {
        type: "turn_failure",
        sessionId: event.sessionId,
        turnId: event.turnId,
        reason,
      } as WSMessage;
      deps.wsHub.broadcast(msg);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
};
```

The handler treats `ApiDeps` as `ApiDeps & AgentDeps` because Task 13 adds those fields to the real `ApiDeps`. The tests inject only the fields the route reads, so they cast.

- [ ] **Step 2: Run the test to verify it passes**

```bash
npx vitest run __tests__/agent/progress-route.test.ts
```

Expected: PASS, 8 tests green.

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/progress.routes.ts __tests__/agent/progress-route.test.ts
git commit -m "feat(api): add HMAC progress webhook receiver"
```

---

### Task 13: Wire ApiDeps + auth bypass + app mount

**Files:**
- Modify: `src/api/types/api-deps.ts`
- Modify: `src/api/middleware/auth.middleware.ts`
- Modify: `src/api/app.ts`

- [ ] **Step 1: Extend `ApiDeps`**

In `src/api/types/api-deps.ts`, add at the top of the imports:

```ts
import type { AgentClient } from "../../agent/agent-client";
import type { ConversationWriter } from "../../agent/conversation-writer";
import type { AgentConfig } from "../../agent/agent-config";
```

Add to the bottom of the `ApiDeps` type body (before the closing `};`):

```ts
  // Multi-agent mode. Null when MULTI_AGENT_FLOW is OFF.
  agentClient: AgentClient | null;
  conversationWriter: ConversationWriter | null;
  agentConfig: AgentConfig;
```

- [ ] **Step 2: Add `/internal/sessions/` to the auth-bypass list**

In `src/api/middleware/auth.middleware.ts`, locate `PUBLIC_POST_PATHS`. It currently looks like:

```ts
const PUBLIC_POST_PATHS = new Set(["/api/pair/exchange", "/api/__update"]);
```

The `/internal/sessions/:sessionId/progress` path is dynamic, so a Set isn't enough. Add a path-prefix check below the Set:

```ts
const PUBLIC_POST_PATHS = new Set(["/api/pair/exchange", "/api/__update"]);
const PUBLIC_POST_PREFIXES = ["/internal/sessions/"];
```

Then update the early-return condition. The current code is:

```ts
if (PUBLIC_PATHS.has(path) || (method === "POST" && PUBLIC_POST_PATHS.has(path))) {
  await next();
  return;
}
```

Replace with:

```ts
const isPublicPostPath =
  method === "POST" &&
  (PUBLIC_POST_PATHS.has(path) ||
    PUBLIC_POST_PREFIXES.some((p) => path.startsWith(p)));
if (PUBLIC_PATHS.has(path) || isPublicPostPath) {
  await next();
  return;
}
```

- [ ] **Step 3: Mount the route**

In `src/api/app.ts`, import the new route factory near the other route imports:

```ts
import { createProgressRoutes } from "./routes/progress.routes";
```

Then mount it. Find the block where the existing `app.route(...)` calls live, and add this line (placement is not load-bearing, but grouping with the other `app.route` calls is the convention):

```ts
  app.route("/internal", createProgressRoutes(deps));
```

- [ ] **Step 4: Typecheck**

```bash
npm run lint
```

Expected: passes. The lint also runs Biome — if Biome complains about ordering or formatting on the changed files, run `npm run format` to fix.

- [ ] **Step 5: Run all agent tests**

```bash
npx vitest run __tests__/agent
```

Expected: 4 test files green (dedupe + conversation-writer + agent-client + progress-route), 24 tests total.

- [ ] **Step 6: Commit**

```bash
git add src/api/types/api-deps.ts src/api/middleware/auth.middleware.ts src/api/app.ts
git commit -m "feat(api): wire agent deps and mount progress route"
```

---

### Task 14: Server boot — construct agent deps when MULTI_AGENT_FLOW is ON

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Read `src/server.ts`**

```bash
wc -l src/server.ts
```

Note the line count and locate (a) where `ApiDeps` is constructed and passed to `createHonoApp`, and (b) where the `ServerConfig` (with `cacheDir`) is finalized.

- [ ] **Step 2: Add imports near the top**

```ts
import { Connection, Client as TemporalClient } from "@temporalio/client";
import { readAgentConfig } from "./agent/agent-config";
import { createAgentClient } from "./agent/agent-client";
import { createConversationWriter } from "./agent/conversation-writer";
import { dirname } from "node:path";
```

- [ ] **Step 3: Build the agent deps before `createHonoApp` is called**

Find the place where `ApiDeps` is composed (typically a `const deps: ApiDeps = { ... }` object literal, or a helper that returns one). Above that, add:

```ts
  const agentConfig = readAgentConfig();
  let agentClient: AgentClient | null = null;
  let conversationWriter: ConversationWriter | null = null;
  if (agentConfig.enabled) {
    const connection = await Connection.connect({ address: agentConfig.temporal.address });
    const temporalClient = new TemporalClient({ connection, namespace: agentConfig.temporal.namespace });
    agentClient = createAgentClient({
      temporalClient,
      taskQueue: agentConfig.temporal.taskQueue,
    });
    // JSONL goes next to (not inside) the SQLite cacheDir, mirroring the
    // existing convention: ~/.threadbase/conversations/.
    const conversationsBaseDir =
      agentConfig.conversationsDir ||
      (() => {
        const dir = dirname(serverConfig.cacheDir); // ~/.threadbase
        return `${dir}/conversations`;
      })();
    conversationWriter = createConversationWriter({ baseDir: conversationsBaseDir });
  }
```

You'll need `import type { AgentClient } from "./agent/agent-client";` and `import type { ConversationWriter } from "./agent/conversation-writer";` at the top to type the `let` declarations.

- [ ] **Step 4: Add the three fields to the `ApiDeps` literal**

Wherever the `ApiDeps` object is constructed (typically as `{ apiKey, sessionStore, wsHub, ... }`), add:

```ts
    agentClient,
    conversationWriter,
    agentConfig,
```

- [ ] **Step 5: Typecheck**

```bash
npm run lint
```

Expected: passes. If there are import-cycle or biome ordering issues, run `npm run format` and re-lint.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): construct agent client when flag is on"
```

---

### Task 15: Add `--multi-agent-flow` CLI flag

**Files:**
- Modify: `cli/index.ts`

- [ ] **Step 1: Read `cli/index.ts`** and locate the existing `.option("--port ...", ...)` or equivalent commander declarations.

- [ ] **Step 2: Add the new option**

In the `serve` (or default) command's options block, add:

```ts
  .option("--multi-agent-flow", "Run in multi-agent mode (PTY mode unreachable in this process)", false)
```

- [ ] **Step 3: When the flag is set, export the env var BEFORE server.ts is imported**

In the action handler for the same command, AT THE TOP (before any other side-effect or import that pulls `server.ts`):

```ts
  if (opts.multiAgentFlow) {
    process.env.MULTI_AGENT_FLOW = "true";
  }
```

If `server.ts` is statically imported at the top of `cli/index.ts`, that timing won't work — `readAgentConfig` already ran. In that case, replace the static import of `server.ts` with a dynamic import inside the action handler, executed AFTER the env var is set:

```ts
  if (opts.multiAgentFlow) {
    process.env.MULTI_AGENT_FLOW = "true";
  }
  const { startServer } = await import("../src/server");
  await startServer({ /* existing options */ });
```

This is intentional: we want `readAgentConfig` to see the flag.

- [ ] **Step 4: Typecheck**

```bash
npm run lint
```

Expected: passes.

- [ ] **Step 5: Verify the flag is wired**

```bash
npx tsx cli/index.ts --help | grep multi-agent
```

Expected output contains:

```
--multi-agent-flow                       Run in multi-agent mode ...
```

- [ ] **Step 6: Commit**

```bash
git add cli/index.ts
git commit -m "feat(cli): add --multi-agent-flow flag"
```

---

### Task 16: Operator documentation

**Files:**
- Create: `docs/multi-agent-mode.md`

- [ ] **Step 1: Write the doc**

```markdown
# Multi-agent mode

When `--multi-agent-flow` (or `MULTI_AGENT_FLOW=true`) is set, tb-streamer routes user input through a Temporal-orchestrated multi-agent pipeline instead of the node-pty Claude Code session. PTY mode is unreachable from a multi-agent-mode process.

To compare the two modes side by side, run two tb-streamer processes on different ports — one with the flag, one without.

## Required services

Multi-agent mode requires a Temporal server and a `tb-multi-agent` worker process. For local dev:

```bash
# Terminal 1: Temporal dev server
temporal server start-dev --ui-port 8233

# Terminal 2: tb-multi-agent worker
cd ../tb-multi-agent
npm run worker

# Terminal 3: tb-streamer in multi-agent mode
cd ../tb-streamer
MULTI_AGENT_FLOW=true PROGRESS_HMAC_SECRET=shared-dev-secret \
  ANTHROPIC_API_KEY=... \
  npm run dev -- --multi-agent-flow --port 3456
```

`PROGRESS_HMAC_SECRET` MUST match between the two processes — set it in both `.env` files.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MULTI_AGENT_FLOW` | (unset) | Set to `true` (or use `--multi-agent-flow`) to enable. |
| `PROGRESS_HMAC_SECRET` | `dev-secret-change-me` | Shared secret with the worker. Match both processes. |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server gRPC. |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace. |
| `TEMPORAL_TASK_QUEUE` | `agent-tasks` | Task queue both processes use. |
| `PROGRESS_DEDUPE_CAPACITY` | `1024` | Per-session LRU size for event dedupe. |
| `PROGRESS_WEBHOOK_TIMESTAMP_SKEW_SECONDS` | `300` | Reject events with timestamps outside this skew. |

## Wire endpoints

- `POST /internal/sessions/:sessionId/progress` — worker → tb-streamer progress webhook. HMAC-signed via `X-Progress-Signature`. Bypasses Bearer auth (HMAC-only).
- Existing WebSocket protocol — augmented with `session_update.stage`, `session_update.stalledSinceMs`, plus two new event types: `agent_output` and `turn_failure`. All additive — old clients ignore unknown fields.

## Smoke test

With all three processes running, send a user input via the WebSocket as you would in PTY mode. Watch:

- tb-streamer logs show one `POST /internal/sessions/:sessionId/progress` per stage transition.
- The Temporal UI at `http://localhost:8233` shows one `session-<id>` orchestrator workflow with one or more `turn-<id>` children.
- The WebSocket emits `session_update` events with stage transitions and `agent_output` blocks per agent.

## Failure modes

- **Worker can't reach tb-streamer.** Webhook fails silently. Final answer is still queryable via Temporal (`getSessionStage`). The frontend reconciles state on WS reconnect.
- **tb-streamer can't reach Temporal.** Server logs the connection error. `MULTI_AGENT_FLOW` requires Temporal — start it before tb-streamer.
- **HMAC misconfig.** Webhook receiver returns 401. Worker logs the 401 and gives up after its retry window. No events reach the UI.
- **tb-streamer restart.** Per-session dedupe map is empty on restart; one duplicate UI event per in-flight Temporal activity retry. See `tb-multi-agent/docs/plans/postgres-dedupe.md` for the durable-dedupe upgrade path.

## Architecture context

- Spec: `tb-multi-agent/docs/superpowers/specs/2026-06-03-tb-multi-agent-mode-design.md`
- Webhook transport: `tb-multi-agent/signed-http-webhook-guide.md`
- Deferred upgrades: `tb-multi-agent/docs/ROADMAP.md`
```

- [ ] **Step 2: Commit**

```bash
git add docs/multi-agent-mode.md
git commit -m "docs: add multi-agent mode operator guide"
```

---

### Task 17: Final check — full repo lint + tests

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: every existing test still passes, plus all new agent tests (~24 across 4 files).

- [ ] **Step 2: Run the full lint**

```bash
npm run lint
```

Expected: no errors. (Biome may surface formatting nits — run `npm run format` and re-lint.)

- [ ] **Step 3: Run the build**

```bash
npm run build
```

Expected: clean build. tsup produces `dist/index.js`, `dist/index.cjs`, `dist/cli.cjs`, and copies the migrations.

- [ ] **Step 4: Smoke the dev server WITHOUT the flag — verify PTY mode is unchanged**

In one terminal:

```bash
npx tsx cli/index.ts serve --port 3456
```

Expected: server starts. No "constructing agent client" or Temporal connection attempt. `GET /healthz` returns 200. Stop with Ctrl-C.

- [ ] **Step 5: Smoke the dev server WITH the flag (Temporal + worker must be running)**

In separate terminals:

1. `temporal server start-dev --ui-port 8233`
2. `cd ../tb-multi-agent && npm run worker`
3. `cd ../tb-multi-agent && npm run smoke:receiver` (NOTE: not needed if tb-streamer's own receiver works — we use the worker's smoke-receiver only to verify the worker's outbound webhook; tb-streamer's receiver is the actual integration target)
4. In tb-streamer: `MULTI_AGENT_FLOW=true PROGRESS_HMAC_SECRET=dev-secret-change-me npx tsx cli/index.ts serve --multi-agent-flow --port 3456`

Then in tb-streamer's `cd ../tb-multi-agent && npm run smoke:session` — but FIRST edit that smoke script's URL to point at tb-streamer (port 3456) instead of the mock receiver:

```bash
PROGRESS_WEBHOOK_URL=http://localhost:3456/internal/sessions npm run smoke:session
```

(Plan 2's smoke script reads `PROGRESS_WEBHOOK_URL` from env — see `src/shared/config.ts`.)

Expected outcomes in tb-streamer's logs:

- Several `POST /internal/sessions/:sessionId/progress 200 ...` lines per turn.
- One `[req]` log line per webhook hit.
- No 401s.
- For each completed turn, one `appendAssistantTurn` call (visible if you tail `~/.threadbase/conversations/<sessionId>.jsonl`).

If you see 401s, the HMAC secret does not match between processes. If you see 404s, the session wasn't started in tb-streamer first — multi-agent mode requires the session to exist in tb-streamer's `SessionStore` before the worker emits progress for it (which is the normal flow: tb-streamer creates the session in `SessionStore`, calls `agentClient.startSession`, then signals `userInput`). For the smoke script in isolation, you can either preload a session via WebSocket or accept that the initial 404 is expected until tb-streamer's session-creation path is exercised by a real client.

Verification only; no commit.

---

## Self-Review

1. **Spec coverage:**
   - §3.1 process topology — Task 14 (server constructs agent client, separate process), Task 15 (CLI flag). ✓
   - §3.2 sequence — handled by Plan 2 (worker) + Tasks 11–12 (receiver) + Task 8 (JSONL writer). ✓
   - §3.3 wire types — consumed via the `@threadbase/agent-types` dep wired in Task 1. ✓
   - §4.2 component table — Task 11–12 (`progress.routes.ts`), Task 6 (`session-store.ts` extension), Task 5 (`types.ts` additions), Task 9–10 (`agent-client.ts`), Task 7–8 (`conversation-writer.ts`), Task 15 (`cli` flag). ✓
   - §5.1 webhook endpoint, headers, auth, idempotency — Task 12. ✓
   - §5.2 WebSocket additions — Task 5 (types) + Task 12 (translation). ✓
   - §6.3 JSONL written by tb-streamer on final agent_output — Task 12 calls `appendAssistantTurn` when `stage === "done"`. ✓
   - §7.1 dedupe — Tasks 3–4, integrated in Task 12. ✓
   - §7.3 best-effort receiver — Task 12 returns 401 on bad sig, 200 on dedupe, errors don't propagate; worker side already implements the retry window in Plan 2. ✓
   - §7.5 turn-failure surfaces but does not set session `status: failed` — Task 12 emits `turn_failure` WSMessage, never touches `session.status`. ✓
   - §9 env vars — Task 2 (config reader), Task 16 (operator doc). ✓
2. **Placeholder scan:** every code step has the full code. Commands have expected output. The fallback "if Biome complains" and "if TS complains about `defineSignal` import path" notes have exact fix instructions, not "figure it out."
3. **Type consistency:**
   - `ProgressDedupeLRU` exported in Task 4, imported in Task 5 (`ManagedSession`), Task 6 (`session-store.ts`). Same shape everywhere.
   - `AgentClient` defined in Task 10, used in `ApiDeps` (Task 13) and constructed in `server.ts` (Task 14). Same constructor shape (`createAgentClient`) wherever called.
   - `ConversationWriter` defined in Task 8, used in `ApiDeps` (Task 13), constructed in `server.ts` (Task 14), called in `progress.routes.ts` (Task 12).
   - `AgentConfig` defined in Task 2, threaded through Tasks 11–13. Single source of truth.
   - `WSMessage` variants added in Task 5 (`agent_output`, `turn_failure`, extended `session_update`) match what Task 12's route constructs and what Task 11's tests assert.
   - The webhook URL prefix `/internal/sessions/:sessionId/progress` is used identically in: Task 12 route declaration, Task 13 auth bypass prefix, Task 1 vendor symlink (no impact), Task 16 docs. Single string, no drift.
4. **Out-of-scope creep:** no changes to PTY code paths, no migration to multi-agent mode by default, no infra additions beyond the `@temporalio/client` dep. ✓

---

## Hand-off

After Plan 3 is shipped, milestone B's user-visible surface is complete:

- Operators can run two streamers side-by-side (one PTY, one multi-agent) and exercise the full pipeline against a real Temporal + Anthropic stack.
- The wire contract is locked: `@threadbase/agent-types` is consumed by both repos as a `file:` dep.
- All deferred upgrades (LLM-as-orchestrator, `continueAsNew`, option D dedupe, escalation path, type-package distribution stage 2+3) are captured in `tb-multi-agent/docs/ROADMAP.md`.
- The next implementation cycle (post-B) starts with whichever roadmap item the operator wants first — most likely `continueAsNew`, since it gates real production traffic.
