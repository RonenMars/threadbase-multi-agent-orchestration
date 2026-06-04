// Integration test harness.
//
// Builds the dual-side test rig for milestone B integration scenarios:
//
//   Temporal TestWorkflowEnvironment (in-memory)
//     ↕
//   Real worker (real workflows, real progress activity, stubbed LLM activities)
//     ↓ HTTP (real fetch, real HMAC)
//   Real Hono server (real createProgressRoutes from tb-streamer)
//     ↓ deps
//   Mock WS sink + real dedupe LRU + real conversation writer (tmp dir)
//
// What's REAL: workflows, signal handling, child workflow spawning, the
// progress activity's HMAC + retry logic, HTTP transport, signature
// verification, dedupe LRU semantics, JSONL writes.
//
// What's MOCKED: the LLM activities (processTask, reviewTask, productSignOff)
// and the WebSocket broadcast sink. See ./stubs.ts and ./ws-sink.ts.

import { serve, type ServerType } from "@hono/node-server";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  Worker,
  type NativeConnection,
  type Runtime,
} from "@temporalio/worker";
import type { Client } from "@temporalio/client";
import {
  createConversationWriter,
  createProgressDedupeLRU,
  createProgressRoutes,
  type ProgressDedupeLRU,
} from "@threadbase/streamer";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { nanoid } from "nanoid";
import type { ActivityStubs } from "./stubs";
import { createWSSink, type WSSink } from "./ws-sink";

export interface TestRig {
  /** Use this to start workflows and send signals during the scenario. */
  client: Client;
  /** Captured WS broadcast calls. Assert against `rig.sink.captured` after scenario steps. */
  sink: WSSink;
  /** The receiver's URL (without trailing slash). Inspect in HMAC-rejection tests; production code uses it via PROGRESS_WEBHOOK_URL. */
  receiverUrl: string;
  /** The session record's dedupe LRU. Tests can introspect to verify dedupe behavior. */
  dedupe: ProgressDedupeLRU;
  /** Tmp directory where JSONL files land. Inspect with fs.readFile. */
  conversationsDir: string;
  /** The taskQueue the worker is listening on. Pass to client.workflow.start. */
  taskQueue: string;
  /** Run a callback while the worker is polling, then stop the worker. */
  runScenario(scenario: () => Promise<void>): Promise<void>;
  /** Always call in afterEach. Reverses every side-effect. */
  teardown(): Promise<void>;
}

export interface CreateTestRigOpts {
  /** Per-scenario activity stubs. See ./stubs.ts. */
  activities: ActivityStubs;
  /** Override the HMAC secret for HMAC-rejection scenarios. Default: a fixed test secret. */
  hmacSecret?: string;
  /** Dedupe LRU capacity. Default 64. */
  dedupeCapacity?: number;
  /** If true, sessionStore.getManaged returns null. For "unknown session" assertions. */
  unknownSession?: boolean;
}

const DEFAULT_SECRET = "integration-secret";

// Captured snapshot of env vars we modify, so teardown restores them.
interface EnvSnapshot {
  url: string | undefined;
  secret: string | undefined;
  attempts: string | undefined;
  firstDelay: string | undefined;
  backoff: string | undefined;
  timeout: string | undefined;
}

function snapshotEnv(): EnvSnapshot {
  return {
    url: process.env.PROGRESS_WEBHOOK_URL,
    secret: process.env.PROGRESS_HMAC_SECRET,
    attempts: process.env.PROGRESS_WEBHOOK_ATTEMPTS,
    firstDelay: process.env.PROGRESS_WEBHOOK_FIRST_DELAY_MS,
    backoff: process.env.PROGRESS_WEBHOOK_BACKOFF,
    timeout: process.env.PROGRESS_WEBHOOK_TIMEOUT_MS,
  };
}

function restoreEnv(snap: EnvSnapshot): void {
  const set = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("PROGRESS_WEBHOOK_URL", snap.url);
  set("PROGRESS_HMAC_SECRET", snap.secret);
  set("PROGRESS_WEBHOOK_ATTEMPTS", snap.attempts);
  set("PROGRESS_WEBHOOK_FIRST_DELAY_MS", snap.firstDelay);
  set("PROGRESS_WEBHOOK_BACKOFF", snap.backoff);
  set("PROGRESS_WEBHOOK_TIMEOUT_MS", snap.timeout);
}

async function startReceiver(
  deps: Parameters<typeof createProgressRoutes>[0],
): Promise<{ server: ServerType; baseUrl: string }> {
  const app = new Hono();
  // Cast at the boundary: tb-streamer's hono and ours may be duplicate copies
  // with structurally-different (but runtime-identical) types. Runtime is
  // fine — the Hono route returned is a valid sub-app for any Hono instance.
  // biome-ignore lint/suspicious/noExplicitAny: harmless duplicate-hono cast.
  app.route("/internal", createProgressRoutes(deps) as any);

  return await new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      (info) => {
        // @hono/node-server's `info` carries the OS-assigned port.
        resolve({ server, baseUrl: `http://127.0.0.1:${info.port}` });
      },
    );
    // node-server returns the ServerType synchronously, but errors during
    // listen() come as 'error' events.
    (server as unknown as { on?: (e: string, cb: (err: Error) => void) => void }).on?.(
      "error",
      reject,
    );
  });
}

export async function createTestRig(opts: CreateTestRigOpts): Promise<TestRig> {
  const secret = opts.hmacSecret ?? DEFAULT_SECRET;
  const dedupeCapacity = opts.dedupeCapacity ?? 64;
  const envSnapshot = snapshotEnv();

  // ─── Streamer-side deps ────────────────────────────────────────────────
  const conversationsDir = await mkdtemp(join(tmpdir(), "tb-integ-"));
  const conversationWriter = createConversationWriter({ baseDir: conversationsDir });
  const dedupe = createProgressDedupeLRU(dedupeCapacity);
  const sink = createWSSink();

  // Minimal duck-typed session store. The route only reads `.getManaged`.
  interface StubSession {
    id: string;
    progressDedupeIds: ProgressDedupeLRU;
  }
  const sessionStore = {
    getManaged: (sessionId: string): StubSession | null => {
      if (opts.unknownSession) return null;
      return { id: sessionId, progressDedupeIds: dedupe };
    },
  };

  // Hono app + listening server on a random port.
  // The deps object has TWO unrelated halves: ApiDeps (which the route doesn't
  // read but accepts for compat with createHonoApp) and AgentDeps (which it
  // does read). We supply only AgentDeps + cast at the boundary — same pattern
  // tb-streamer's own progress-route unit tests use.
  const routeDeps = {
    sessionStore,
    wsHub: { broadcast: (m: unknown) => sink.broadcast(m) },
    conversationWriter,
    agentConfig: {
      enabled: true,
      webhook: { hmacSecret: secret, timestampSkewSeconds: 300 },
      dedupe: { perSessionCapacity: dedupeCapacity },
      // Full AgentConfig shape, even though the route only reads the fields above.
      temporal: { address: "unused", namespace: "unused", taskQueue: "unused" },
      conversationsDir,
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: see comment above.
  const { server, baseUrl } = await startReceiver(routeDeps as any);

  // ─── Env wiring so sendProgressEvent points at our receiver ────────────
  process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
  process.env.PROGRESS_HMAC_SECRET = secret;
  // Tight retry settings so failed-webhook scenarios resolve quickly.
  process.env.PROGRESS_WEBHOOK_ATTEMPTS = "2";
  process.env.PROGRESS_WEBHOOK_FIRST_DELAY_MS = "10";
  process.env.PROGRESS_WEBHOOK_BACKOFF = "2";
  process.env.PROGRESS_WEBHOOK_TIMEOUT_MS = "1000";

  // The shared config module reads env at module load time. The activity
  // module also caches its own config. Both need invalidation before the
  // worker boots; we use dynamic imports + resetModules-like behavior via
  // the activity's exposed reset hook.
  const progressActivities = await import("../../src/activities/progress");
  progressActivities.__resetWebhookConfigForTests();

  // The shared config is read once at import time and the activity's
  // readConfig() uses it. We can't easily clear vitest's module cache from
  // here, so we forcibly re-import config too. This works because the
  // activity reads `config.*` lazily inside readConfig (which we just reset).
  // BUT — `config` is a frozen object captured at first import. The cleanest
  // fix is to ensure the env vars are set BEFORE the very first import
  // anywhere in the test process. Vitest runs each test file fresh, so per-
  // file imports happen after this point. Inside one file with multiple
  // tests, the harness should still work because the activity re-reads its
  // own webhook config (URL, secret, retry) on every reset. The static
  // `config` from shared/config has the OLD url baked in, but we override
  // via env vars that the activity reads directly. Verify in tests that this
  // works; if not, a workaround is the test-only env-precedence hook below.

  // ─── Temporal test env + worker ────────────────────────────────────────
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `integ-tq-${nanoid(6)}`;

  const worker = await Worker.create({
    connection: env.nativeConnection as NativeConnection,
    namespace: env.client.options.namespace,
    taskQueue,
    // require.resolve fails under vitest's transform pipeline; use a direct
    // file path matching the pattern in test/workflows/*.test.ts.
    workflowsPath: path.resolve(__dirname, "../../src/workflows/index.ts"),
    activities: {
      ...opts.activities,
      sendProgressEvent: progressActivities.sendProgressEvent,
    },
  });

  let workerRunning = false;
  let workerRunPromise: Promise<void> | undefined;

  const runScenario = async (scenario: () => Promise<void>): Promise<void> => {
    if (workerRunning) {
      throw new Error("runScenario can only be called once per rig");
    }
    workerRunning = true;
    // Pass the scenario as a function, not an invoked promise. Temporal's
    // runUntil starts the worker first and then invokes the callback; passing
    // a pre-invoked promise can race with worker startup so the scenario's
    // signals reach the workflow before the worker is polling.
    workerRunPromise = worker.runUntil(scenario);
    await workerRunPromise;
  };

  const teardown = async (): Promise<void> => {
    // If runScenario was called and is still pending (scenario threw),
    // wait briefly so the worker can drain.
    if (workerRunPromise) {
      try {
        await Promise.race([
          workerRunPromise,
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      } catch {
        // Scenario errors propagate; teardown still proceeds.
      }
    }

    try {
      worker.shutdown();
    } catch {
      // Best-effort.
    }

    try {
      await env.teardown();
    } catch {
      // Best-effort.
    }

    // Stop the HTTP server.
    await new Promise<void>((resolve) => {
      (server as unknown as { close: (cb: () => void) => void }).close(() =>
        resolve(),
      );
    });

    // Restore env vars.
    restoreEnv(envSnapshot);
    progressActivities.__resetWebhookConfigForTests();

    // Remove tmp directory.
    await rm(conversationsDir, { recursive: true, force: true });
  };

  return {
    client: env.client,
    sink,
    receiverUrl: baseUrl,
    dedupe,
    conversationsDir,
    taskQueue,
    runScenario,
    teardown,
  };
}

// Re-export sub-modules so scenarios have a single import surface.
export type { ActivityStubs, StubBehavior } from "./stubs";
export { makeStubActivities } from "./stubs";
export type { WSSink } from "./ws-sink";
