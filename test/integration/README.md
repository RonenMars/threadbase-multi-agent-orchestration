# Integration tests — milestone B

Verify that the **worker side** (this repo: orchestrator workflow, turn workflow, progress activity) and the **streamer side** (`tb-streamer`: webhook receiver, dedupe, WS broadcast, JSONL persistence) speak the same wire language.

The unit tests in `test/workflows/` and `test/activities/` cover the two halves in isolation. These integration tests cover the **boundary** — the place where contract drift would otherwise go unnoticed until manual smoke.

## What "integration" means here

These tests are **in-process**: a single `vitest` run drives both halves of the system in the same Node process. No real Temporal server, no real Anthropic API, no separate tb-streamer process.

The cross-process behavior we DO exercise:

- **Real Temporal workflow execution** via `TestWorkflowEnvironment` (in-memory). Workflow `await`s, signal handlers, child workflows, replay all run for real.
- **Real HTTP** from the progress activity (`sendProgressEvent`) to the receiver. The activity uses `fetch` against a local Hono app on a random port.
- **Real HMAC** signing on the worker side, real HMAC verification on the streamer side.
- **Real dedupe LRU** on a stub `ManagedSession` record.
- **Real WS broadcast** call, captured by a mock sink (`ws-sink.ts`) instead of an actual `WebSocket`.
- **Real JSONL writes** to a per-test tmp directory.

What we DON'T exercise:
- Real Temporal server's task-queue dispatch across workers (only one in-process worker exists). Replay safety is tested via a workflow-restart pattern; the cross-worker case is covered by Temporal's own test suite.
- Real LLM calls. `processTask`, `reviewTask`, `productSignOff` are stubbed per scenario.
- Real WebSocket protocol. We assert on the *messages* the streamer would broadcast, not on actual socket frames.

## How tb-streamer is consumed

tb-streamer is wired in as a **local file dependency** in `package.json`:

```json
"@threadbase/streamer": "file:../tb-streamer"
```

`npm install` creates a symlink at `node_modules/@threadbase/streamer` pointing at the sibling tb-streamer checkout. The integration tests import directly from the symlinked `dist/` — whatever you've built locally is what the tests see.

### Requirements for local consumption

- **Sibling checkout:** both repos must be checked out as siblings (`tb-multi-agent/` and `tb-streamer/` in the same parent directory).
- **`dist/` built:** the symlinked `dist/index.js` + `dist/index.d.ts` must exist. Run `npm --prefix ../tb-streamer run build` if they don't (or if you've changed tb-streamer code and need the tests to see it).

### Why file dep, not GitHub or npm

This is a deliberate trade-off, not a permanent state. The honest reason: **tb-streamer's npm distribution story isn't ready yet.**

- **GitHub install** (`github:RonenMars/threadbase-streamer#<sha>`) fails because tb-streamer's `postinstall` requires the `vendor/scanner` git submodule to be populated, and npm doesn't init submodules when cloning from GitHub URLs.
- **GitHub Release tarballs** exist (`v1.3.0` has them) but they're platform-specific binary distributions (~21 MB each, with native node-pty prebuilds) made for the streamer's `update` command — not consumable via `npm install`.
- **npm registry publish** is disabled in tb-streamer's semantic-release config (`npmPublish: false`).

The full gap analysis and recommended fix path live in [`docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md`](../../docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md). When that work lands, the dep here flips to a registry version (e.g. `^1.4.0`) and the sibling-checkout requirement goes away.

### Implications

- **Local tb-streamer changes are visible immediately.** Save a file in tb-streamer, rebuild (`npm run build` there), re-run integration tests — no version bump needed.
- **CI is harder.** Any CI that runs integration tests must check out both repos. There is no CI for these tests yet; when one exists, it'll need to script `git clone tb-streamer && cd tb-streamer && npm install && npm run build` before testing tb-multi-agent.
- **No version pinning today.** Tests run against `HEAD` of the local tb-streamer checkout, whatever that is. Both repos are on the `feat/milestone-b-*` feature branches; cross-repo state moves together.

## Layout

```
test/integration/
├── README.md                 # this file
├── harness.ts                # builds the test rig: workflow env + HTTP server + WS sink
├── ws-sink.ts                # captures wsHub.broadcast() calls for assertions
├── stubs.ts                  # processTask/reviewTask/productSignOff stub factories
└── scenarios/
    ├── happy-path.test.ts    # 1 turn → all expected events broadcast
    ├── dedupe.test.ts        # same eventId twice → second deduped
    ├── rework-cap.test.ts    # reviewer never approves → reviewerOverruled flag
    ├── hmac-rejection.test.ts # bad signature → 401, no broadcast, no JSONL
    ├── signal-serialization.test.ts # 2 signals → second emits `queued`
    ├── child-failure.test.ts # activity throws → turn_failure broadcast
    └── replay-safety.test.ts # workflow replay → no duplicate broadcast
```

## The harness

`harness.ts` exports a single function:

```ts
export interface TestRig {
  /** TestWorkflowEnvironment-backed Temporal client for starting workflows. */
  client: Client;
  /** Captured WS broadcast calls. Asserted on after the scenario runs. */
  sink: WSSink;
  /** The Hono server's listening URL, e.g. http://127.0.0.1:54321. */
  receiverUrl: string;
  /** The session record's dedupe LRU (passed into the route via deps). */
  dedupe: ProgressDedupeLRU;
  /** Directory where JSONL files are written for this test. */
  conversationsDir: string;
  /** Cleanup. Always called in afterEach. */
  teardown(): Promise<void>;
}

export async function createTestRig(opts: {
  /** Per-scenario activity stubs. */
  activities: ActivityStubs;
  /** HMAC secret. Defaults to "integration-secret"; override for HMAC-rejection scenario. */
  hmacSecret?: string;
  /** Dedupe capacity. Defaults to 64. */
  dedupeCapacity?: number;
}): Promise<TestRig>;
```

Inside `createTestRig`, the construction order is:

1. **Create a fresh tmp directory** for JSONL writes.
2. **Construct the streamer-side deps:**
   - `conversationWriter = createConversationWriter({ baseDir: tmpDir })`
   - `dedupe = createProgressDedupeLRU(capacity)`
   - `sink = createWSSink()` (mock broadcast)
   - `sessionStore = { getManaged: (id) => ({ id, progressDedupeIds: dedupe }) }`
3. **Start a Hono server** on a random port, mounting the real `createProgressRoutes(deps)` from `@threadbase/streamer`.
4. **Construct `TestWorkflowEnvironment.createTimeSkipping()`.** Configure a `Worker` with:
   - The real `orchestratorWorkflow` and `turnWorkflow` modules.
   - The real `sendProgressEvent` activity (so it makes real HTTP to our server).
   - The scenario's stubbed `processTask`/`reviewTask`/`productSignOff`.
5. **Set env vars** (`PROGRESS_WEBHOOK_URL`, `PROGRESS_HMAC_SECRET`) so the activity reads the right values. The harness resets these in teardown.
6. **Return the rig.** Tests call `client.workflow.start(...)` to drive scenarios.

`teardown()` reverses everything: cancels running workflows, stops the worker, tears down the Temporal env, closes the HTTP server, removes the tmp dir, restores env vars.

## Per-scenario shape

Each scenario file is a self-contained vitest suite:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRig, type TestRig } from "../harness";
import { makeStubActivities } from "../stubs";

describe("happy path", () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = await createTestRig({
      activities: makeStubActivities({ reviewerApprovesAfter: 0 }),
    });
  });
  afterEach(() => rig.teardown());

  it("...", async () => { /* ... */ });
});
```

The scenarios only assert on **observable outputs**:
- `rig.sink.captured` — the broadcast call log.
- JSONL files in `rig.conversationsDir`.
- HTTP-level facts (HMAC scenario only — we send raw fetch requests).
- Workflow result values.

They do NOT touch implementation details (no peeking at `dedupe.size`, no inspecting workflow internals). That keeps the suite robust against refactors of either repo.

## Running

```bash
npm test                          # all tests including integration
npm test test/integration         # just integration
npm test test/integration/scenarios/happy-path.test.ts  # one scenario
```

First-run note: if `node_modules/@threadbase/streamer` doesn't exist, `npm install` creates the symlink to `../tb-streamer`. If the symlinked `dist/` is missing or stale, run `npm --prefix ../tb-streamer run build` first.

## Adding a new scenario

1. Create `test/integration/scenarios/<name>.test.ts`.
2. Define your activity stubs (see `stubs.ts` for the existing helpers).
3. Build the rig in `beforeEach`, tear down in `afterEach`.
4. Drive the workflow via `rig.client.workflow.start(...)` or `.signal(...)`.
5. Assert on `rig.sink.captured` and/or files in `rig.conversationsDir`.

If your scenario needs a new activity stub variant, add it to `stubs.ts`. Keep `harness.ts` scenario-agnostic.

## When NOT to use these tests

- **Don't test the LLM**. These tests stub Anthropic. If you need to verify the real LLM behavior, run the manual smoke (`docs/superpowers/specs/2026-06-03-tb-multi-agent-mode-design.md` §11 step 11).
- **Don't test the WebSocket protocol**. The mock sink captures broadcast calls but doesn't open real sockets. tb-streamer's own unit tests cover the WS layer.
- **Don't test Temporal's own correctness**. Replay safety is tested at the *invariant* level (does the dedupe LRU catch the duplicate event?), not at the SDK level.

## Failure modes to expect

- **Port conflict** if you run the suite in parallel mode and the random-port allocation collides. Vitest runs files in parallel by default; the harness uses port 0 (OS-assigned), so this should not happen in practice. If it does, set `--no-file-parallelism` in vitest.
- **Stale tb-streamer `dist/`** if you change tb-streamer code locally and forget to rebuild. The symlinked package serves whatever is currently in `../tb-streamer/dist/`. Run `npm --prefix ../tb-streamer run build` to refresh.
- **Missing tb-streamer checkout** if `../tb-streamer/` doesn't exist (e.g., on a fresh clone of just tb-multi-agent). `npm install` will fail with a path-not-found error pointing at `vendor/agent-types` resolution. Clone tb-streamer as a sibling before installing.
- **`TestWorkflowEnvironment` startup latency** — ~1–2s per suite file. The orchestrator unit tests already accept this; integration tests inherit the same trade-off.

## Roadmap

- Promote tb-streamer to a published npm package, eliminating the sibling-checkout requirement. Full design + scope in [`docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md`](../../docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md). Captured in `docs/ROADMAP.md`.
- Add a third "live Temporal" suite (opt-in via `npm run test:live-temporal`) that runs against `temporal server start-dev` and exercises real cross-worker dispatch. Out of scope for milestone B.
