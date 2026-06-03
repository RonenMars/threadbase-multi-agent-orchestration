# Plan 1 — `@threadbase/agent-types` Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `@threadbase/agent-types` package containing every wire type used between `tb-multi-agent` (worker process) and `tb-streamer` (Temporal client + WebSocket hub). The package lives inside the tb-multi-agent repo and is consumed by both repos as a local `file:` dependency for milestone B.

**Architecture:** A self-contained TypeScript package with zero runtime dependencies. Exports the stage enum, progress event envelope, signal payload type, session shape addendum, and final-answer payload — exactly as defined in spec §3.3. Builds to CommonJS (matching tb-multi-agent's existing module setting) so both consumers can import without transpiler gymnastics. Validates via unit tests that the exported types compose correctly and that runtime helpers (the stage enum) behave as documented.

**Tech Stack:** TypeScript 5.6, vitest for unit tests, no other runtime deps. Package layout: `packages/agent-types/` inside the tb-multi-agent repo.

---

## Scope

This plan creates **only** the shared package. It does NOT:

- Modify the existing tb-multi-agent worker, workflows, or activities (that is Plan 2).
- Touch tb-streamer at all (that is Plan 3).
- Wire the `file:` dep into either repo's `package.json` (the consumers do that wiring in their own plans, so they can be installed independently).

This plan is shippable on its own: at the end, the package builds, all tests pass, and it can be `npm install`-ed via a relative file path from any sibling project.

---

## File Structure

All paths relative to the tb-multi-agent repo root.

| Path | Purpose |
|---|---|
| `packages/agent-types/package.json` | Package manifest. `main`/`types` point at `dist/`. No runtime deps. |
| `packages/agent-types/tsconfig.json` | TS config. Emits `.js` + `.d.ts` to `dist/`. CommonJS to match the parent repo. |
| `packages/agent-types/src/index.ts` | Public surface. Re-exports everything from sibling files. The ONLY entry point consumers should import. |
| `packages/agent-types/src/stage.ts` | `STAGES` const tuple + `Stage` union type. |
| `packages/agent-types/src/progress.ts` | `ProgressEventType`, `ProgressEvent`, `AgentOutputPayload`. |
| `packages/agent-types/src/signal.ts` | `ConversationTurn`, `UserInputSignal`. |
| `packages/agent-types/src/session.ts` | `SessionStageAddendum`. |
| `packages/agent-types/test/stage.test.ts` | Asserts the stage tuple matches the documented list and `Stage` is the expected union. |
| `packages/agent-types/test/progress.test.ts` | Type-level smoke tests for `ProgressEvent` and `AgentOutputPayload` (compile-time + minimal runtime). |
| `packages/agent-types/test/index.test.ts` | Asserts every documented type re-exports from `index.ts`. |
| `packages/agent-types/.gitignore` | Ignores `dist/` and `node_modules/`. |
| `packages/agent-types/README.md` | One-paragraph orientation: what this is, why it's a `file:` dep, where to look for the spec. |
| Root `package.json` (modify) | Adds `workspaces` declaration so `npm install` from the repo root installs and links the package. Adds a `build:types` script. |
| Root `tsconfig.json` (modify) | Add a `references` block pointing at the package, so a top-level typecheck verifies the package too. |

Each file has one responsibility. The split mirrors the spec's logical grouping (stage / progress / signal / session) so future edits stay focused.

---

## Tasks

### Task 1: Scaffold the package directory + manifest

**Files:**
- Create: `packages/agent-types/package.json`
- Create: `packages/agent-types/.gitignore`
- Create: `packages/agent-types/README.md`

- [ ] **Step 1: Create the package directory and write `.gitignore`**

```bash
mkdir -p packages/agent-types/src packages/agent-types/test
```

Content for `packages/agent-types/.gitignore`:

```
dist/
node_modules/
*.tsbuildinfo
```

- [ ] **Step 2: Write `packages/agent-types/package.json`**

```json
{
  "name": "@threadbase/agent-types",
  "version": "0.1.0",
  "private": true,
  "description": "Shared wire types for the Threadbase multi-agent pipeline (tb-multi-agent ↔ tb-streamer).",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "src", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Notes for the engineer:
- `private: true` keeps this from being publishable. Milestone B locks the distribution at stage 1 (local `file:` dep) — see `docs/ROADMAP.md` for the publish-to-npm path.
- `"files"` declares what ships if the package ever IS published. `dist` is the built output; `src` is included so consumers can debug into source.
- No runtime deps. `vitest` and `typescript` are devDeps only.

- [ ] **Step 3: Write `packages/agent-types/README.md`**

```markdown
# @threadbase/agent-types

Shared wire types for the Threadbase multi-agent pipeline.

These types live on the boundary between two processes:

- `tb-multi-agent` — the Temporal worker that runs the orchestrator + turn workflows and the AI-agent activities.
- `tb-streamer` — the Temporal client that owns the WebSocket connection to the mobile frontend and writes JSONL.

Both processes import from this package so the wire shapes (progress events, signal payloads, session addendum, final-answer flags) stay in sync.

## Distribution status

Milestone B keeps this as a **local `file:` dependency**. Both consumers point their `package.json` at a relative path into this directory.

The roadmap promotes it to a git submodule (matching `vendor/scanner` in `tb-streamer`) and eventually to a published npm package. See `docs/ROADMAP.md` and `docs/superpowers/specs/2026-06-03-tb-multi-agent-mode-design.md` for context.
```

- [ ] **Step 4: Verify the layout**

Run:

```bash
ls -la packages/agent-types
```

Expected:

```
.gitignore
README.md
package.json
src/
test/
```

- [ ] **Step 5: Commit**

```bash
git add packages/agent-types
git commit -m "feat(agent-types): scaffold package directory and manifest"
```

---

### Task 2: TypeScript config for the package

**Files:**
- Create: `packages/agent-types/tsconfig.json`

- [ ] **Step 1: Write `packages/agent-types/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "lib": ["ES2021"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "incremental": true,
    "types": []
  },
  "include": ["src/**/*.ts"],
  "exclude": ["test", "dist", "node_modules"]
}
```

Notes:
- `module: CommonJS` matches the parent repo's `package.json` `"type": "commonjs"`. This avoids ESM/CJS interop bugs when tb-streamer consumes the package.
- `declaration: true` and `declarationMap: true` ship `.d.ts` + maps so consumers get jump-to-definition into source.
- `composite: true` lets the parent repo's `tsconfig.json` use `references` to typecheck this package as part of a workspace build.
- `types: []` makes the package self-contained — it doesn't pull in `@types/node` or anything else accidentally.
- Tests live under `test/` and are excluded from the build; vitest reads them directly via tsx-style transformation.

- [ ] **Step 2: Verify TS config is valid**

Run from the repo root:

```bash
cd packages/agent-types
npm install
npm run typecheck
```

Expected: no errors. `src/` is empty so there's nothing to typecheck yet — but this confirms the config parses and `tsc` runs cleanly.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-types/tsconfig.json packages/agent-types/package-lock.json
git commit -m "feat(agent-types): add typescript build config"
```

---

### Task 3: Stage enum — failing test

**Files:**
- Create: `packages/agent-types/test/stage.test.ts`

This is the first TDD cycle. We write the test, watch it fail, then implement to satisfy it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-types/test/stage.test.ts
import { describe, expect, it } from 'vitest';
import { STAGES, type Stage } from '../src/stage';

describe('STAGES', () => {
  it('contains exactly the seven documented stages in pipeline order', () => {
    expect(STAGES).toEqual([
      'thinking',
      'queued',
      'processing',
      'review',
      'rework',
      'sign-off',
      'done',
    ]);
  });

  it('is a readonly tuple (frozen / immutable at runtime)', () => {
    // The `as const` assertion makes STAGES a readonly tuple at the type level.
    // We assert at runtime too: pushing must throw.
    expect(() => {
      // @ts-expect-error — STAGES is readonly; this is the runtime guard for it.
      STAGES.push('not-a-stage');
    }).toThrow();
  });

  it('lets every value type-check as Stage', () => {
    // Compile-time check — assigning each member to `Stage` must compile.
    // If the union is wrong, this won't compile and the test file won't build.
    const samples: Stage[] = [
      'thinking',
      'queued',
      'processing',
      'review',
      'rework',
      'sign-off',
      'done',
    ];
    expect(samples).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `packages/agent-types/`:

```bash
npm test -- test/stage.test.ts
```

Expected: FAIL with a module-resolution error like `Failed to resolve import "../src/stage"`. The file doesn't exist yet.

---

### Task 4: Stage enum — implementation

**Files:**
- Create: `packages/agent-types/src/stage.ts`

- [ ] **Step 1: Write the minimal implementation**

```ts
// packages/agent-types/src/stage.ts

/**
 * The seven stages a turn passes through. Declared as a readonly tuple so the
 * `Stage` type is the exact union of these literals — `string` on the wire for
 * additive compatibility, but type-checked internally.
 */
export const STAGES = [
  'thinking',
  'queued',
  'processing',
  'review',
  'rework',
  'sign-off',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];
```

The `as const` assertion makes the array a readonly tuple at the type level. At the *runtime* level, freezing the array is what makes `push` throw — so we also need to call `Object.freeze`. Update the file:

```ts
// packages/agent-types/src/stage.ts

/**
 * The seven stages a turn passes through. Declared as a readonly tuple so the
 * `Stage` type is the exact union of these literals — `string` on the wire for
 * additive compatibility, but type-checked internally.
 */
export const STAGES = Object.freeze([
  'thinking',
  'queued',
  'processing',
  'review',
  'rework',
  'sign-off',
  'done',
] as const);

export type Stage = (typeof STAGES)[number];
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
npm test -- test/stage.test.ts
```

Expected: PASS, 3 tests green.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-types/src/stage.ts packages/agent-types/test/stage.test.ts
git commit -m "feat(agent-types): add Stage enum and STAGES tuple"
```

---

### Task 5: Progress event types — failing test

**Files:**
- Create: `packages/agent-types/test/progress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-types/test/progress.test.ts
import { describe, expect, it } from 'vitest';
import type {
  ProgressEvent,
  ProgressEventType,
  AgentOutputPayload,
} from '../src/progress';
import type { Stage } from '../src/stage';

describe('ProgressEvent', () => {
  it('accepts a minimal stage_transition event', () => {
    const stage: Stage = 'processing';
    const ev: ProgressEvent = {
      sessionId: 'sess_abc',
      turnId: 'turn_001',
      eventId: 'evt_123',
      seq: 0,
      type: 'stage_transition',
      stage,
      timestamp: 1717430000,
    };
    expect(ev.type).toBe('stage_transition');
  });

  it('accepts an agent_output event with payload', () => {
    const payload: AgentOutputPayload = {
      content: 'Here is the draft.',
    };
    const ev: ProgressEvent = {
      sessionId: 'sess_abc',
      turnId: 'turn_001',
      eventId: 'evt_124',
      seq: 1,
      type: 'agent_output',
      timestamp: 1717430001,
      payload: payload as unknown as Record<string, unknown>,
    };
    expect(ev.payload?.content).toBe('Here is the draft.');
  });

  it('accepts a terminal_failure event', () => {
    const ev: ProgressEvent = {
      sessionId: 'sess_abc',
      turnId: 'turn_001',
      eventId: 'evt_125',
      seq: 2,
      type: 'terminal_failure',
      timestamp: 1717430002,
      payload: { reason: 'activity exhausted retries' },
    };
    expect(ev.type).toBe('terminal_failure');
  });

  it('carries reworkAttempt when stage is rework', () => {
    const ev: ProgressEvent = {
      sessionId: 'sess_abc',
      turnId: 'turn_001',
      eventId: 'evt_126',
      seq: 3,
      type: 'stage_transition',
      stage: 'rework',
      reworkAttempt: 1,
      timestamp: 1717430003,
    };
    expect(ev.reworkAttempt).toBe(1);
  });
});

describe('ProgressEventType', () => {
  it('is the union of the three documented event kinds', () => {
    const kinds: ProgressEventType[] = ['stage_transition', 'agent_output', 'terminal_failure'];
    expect(kinds).toHaveLength(3);
  });
});

describe('AgentOutputPayload', () => {
  it('accepts a content-only payload', () => {
    const p: AgentOutputPayload = { content: 'hi' };
    expect(p.content).toBe('hi');
  });

  it('accepts a partial flag', () => {
    const p: AgentOutputPayload = { content: 'partial draft', partial: true };
    expect(p.partial).toBe(true);
  });

  it('accepts a reviewerOverruled flag for rework-cap case', () => {
    const p: AgentOutputPayload = {
      content: 'final draft, reviewer was not happy',
      reviewerOverruled: true,
    };
    expect(p.reviewerOverruled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/progress.test.ts
```

Expected: FAIL with `Failed to resolve import "../src/progress"`.

---

### Task 6: Progress event types — implementation

**Files:**
- Create: `packages/agent-types/src/progress.ts`

- [ ] **Step 1: Write the implementation**

```ts
// packages/agent-types/src/progress.ts
import type { Stage } from './stage';

/**
 * The three event kinds the worker may emit to tb-streamer over the webhook.
 *
 * - stage_transition: the workflow has moved to a new stage. Carries `stage`,
 *   and `reworkAttempt` when `stage === 'rework'`.
 * - agent_output: an agent (worker / reviewer / sign-off) has produced an
 *   output block to surface to the UI as a chat message. Carries an
 *   `AgentOutputPayload` in `payload`.
 * - terminal_failure: the turn has failed and will not produce more output.
 *   Carries a free-form reason in `payload`.
 */
export type ProgressEventType =
  | 'stage_transition'
  | 'agent_output'
  | 'terminal_failure';

/**
 * The envelope worker activities POST to tb-streamer's webhook receiver.
 *
 * Identity:
 * - `sessionId` routes the event to the right WebSocket connection.
 * - `turnId` groups events that belong to the same user turn.
 * - `eventId` is the dedupe key. MUST be generated in workflow code via
 *   `workflow.uuid4()` so it survives Temporal replay — see spec §7.6.
 * - `seq` is monotonic within a turn for stable ordering.
 *
 * Wire compatibility:
 * - `stage` is typed as `Stage` here (the package owns the enum), but the
 *   webhook receiver accepts it as `string` for additive compatibility, so
 *   the server can ship a new stage value without the client needing a
 *   coordinated release.
 */
export interface ProgressEvent {
  sessionId: string;
  turnId: string;
  eventId: string;
  seq: number;
  type: ProgressEventType;
  stage?: Stage;
  reworkAttempt?: number;
  timestamp: number;
  payload?: Record<string, unknown>;
}

/**
 * Payload of an `agent_output` event. Stored in `ProgressEvent.payload`.
 *
 * - `content` is the body of the chat block the UI will render.
 * - `partial` is reserved for a future streaming-token mode; in milestone B
 *   blocks are always complete on emission, so this is always undefined.
 * - `reviewerOverruled` is set on the FINAL agent_output when the rework
 *   cap was hit and the answer is being delivered without reviewer approval.
 *   See spec §7.4.
 */
export interface AgentOutputPayload {
  content: string;
  partial?: boolean;
  reviewerOverruled?: boolean;
}
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
npm test -- test/progress.test.ts
```

Expected: PASS, 7 tests green.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-types/src/progress.ts packages/agent-types/test/progress.test.ts
git commit -m "feat(agent-types): add ProgressEvent envelope and payload types"
```

---

### Task 7: Signal payload types — failing test

**Files:**
- Create: `packages/agent-types/test/signal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-types/test/signal.test.ts
import { describe, expect, it } from 'vitest';
import type { ConversationTurn, UserInputSignal } from '../src/signal';

describe('ConversationTurn', () => {
  it('accepts a user turn', () => {
    const t: ConversationTurn = { role: 'user', content: 'hello' };
    expect(t.role).toBe('user');
  });

  it('accepts an assistant turn', () => {
    const t: ConversationTurn = { role: 'assistant', content: 'hi there' };
    expect(t.role).toBe('assistant');
  });
});

describe('UserInputSignal', () => {
  it('carries a turn id, prompt, and full conversation history snapshot', () => {
    const sig: UserInputSignal = {
      turnId: 'turn_001',
      prompt: 'What is the capital of France?',
      conversationHistory: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    expect(sig.turnId).toBe('turn_001');
    expect(sig.conversationHistory).toHaveLength(2);
  });

  it('accepts an empty history (first turn in a session)', () => {
    const sig: UserInputSignal = {
      turnId: 'turn_000',
      prompt: 'first message',
      conversationHistory: [],
    };
    expect(sig.conversationHistory).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/signal.test.ts
```

Expected: FAIL with `Failed to resolve import "../src/signal"`.

---

### Task 8: Signal payload types — implementation

**Files:**
- Create: `packages/agent-types/src/signal.ts`

- [ ] **Step 1: Write the implementation**

```ts
// packages/agent-types/src/signal.ts

/**
 * One entry in the conversationHistory snapshot.
 *
 * Owned by tb-streamer in milestone B — tb-streamer composes the snapshot from
 * its existing ConversationCache (SQLite-backed). The shape is mirrored here so
 * the signal payload has a stable wire type.
 *
 * Additional fields (timestamp, metadata, tool calls) may be added without
 * breaking compatibility: the orchestrator only forwards the snapshot through
 * to activities, it does not inspect entry shape.
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Payload sent by tb-streamer with every `userInput` signal to a session's
 * long-lived orchestrator workflow.
 *
 * - `turnId` is allocated by tb-streamer per user message; it is the same
 *   turn id worn by every progress event the resulting turn emits.
 * - `prompt` is the user's message text.
 * - `conversationHistory` is a snapshot tb-streamer composes from its cache.
 *   It rides in the payload instead of living in workflow state — see
 *   spec §6.1 for the rationale (option B.1).
 */
export interface UserInputSignal {
  turnId: string;
  prompt: string;
  conversationHistory: ConversationTurn[];
}
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
npm test -- test/signal.test.ts
```

Expected: PASS, 4 tests green.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-types/src/signal.ts packages/agent-types/test/signal.test.ts
git commit -m "feat(agent-types): add UserInputSignal and ConversationTurn"
```

---

### Task 9: Session shape addendum — failing test

**Files:**
- Create: `packages/agent-types/test/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-types/test/session.test.ts
import { describe, expect, it } from 'vitest';
import type { SessionStageAddendum } from '../src/session';
import type { Stage } from '../src/stage';

describe('SessionStageAddendum', () => {
  it('is fully optional (all fields undefined is valid)', () => {
    const a: SessionStageAddendum = {};
    expect(a).toEqual({});
  });

  it('accepts the documented Stage values', () => {
    const stages: Stage[] = [
      'thinking', 'queued', 'processing', 'review', 'rework', 'sign-off', 'done',
    ];
    for (const stage of stages) {
      const a: SessionStageAddendum = { stage };
      expect(a.stage).toBe(stage);
    }
  });

  it('widens to string for additive wire compatibility', () => {
    // A future stage value that does not exist in the current Stage union
    // must still be assignable, because the wire field is widened to string.
    const a: SessionStageAddendum = { stage: 'some-future-stage' };
    expect(a.stage).toBe('some-future-stage');
  });

  it('carries stalledSinceMs for hang detection', () => {
    const a: SessionStageAddendum = { stalledSinceMs: 2500 };
    expect(a.stalledSinceMs).toBe(2500);
  });

  it('carries reworkAttempt when stage is rework', () => {
    const a: SessionStageAddendum = { stage: 'rework', reworkAttempt: 2 };
    expect(a.reworkAttempt).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/session.test.ts
```

Expected: FAIL with `Failed to resolve import "../src/session"`.

---

### Task 10: Session shape addendum — implementation

**Files:**
- Create: `packages/agent-types/src/session.ts`

- [ ] **Step 1: Write the implementation**

```ts
// packages/agent-types/src/session.ts
import type { Stage } from './stage';

/**
 * Fields added to tb-streamer's existing session shape (and the
 * `session_update` WebSocket event) for multi-agent mode.
 *
 * Every field is optional so this remains additive — existing mobile clients
 * that don't know about `stage` keep working; new clients can render
 * per-stage UI affordances.
 *
 * - `stage` widens to `string` on the wire so the worker can ship a new
 *   stage value before clients are updated. Internally we type it as
 *   `Stage | string` to keep autocomplete + literal-checking on the
 *   producer side.
 * - `stalledSinceMs` is the number of milliseconds the session has been on
 *   the current stage without progress. The frontend uses it to surface
 *   "still working…" or to flag a hang.
 * - `reworkAttempt` is only meaningful when `stage === 'rework'`.
 */
export interface SessionStageAddendum {
  stage?: Stage | string;
  stalledSinceMs?: number;
  reworkAttempt?: number;
}
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
npm test -- test/session.test.ts
```

Expected: PASS, 5 tests green.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-types/src/session.ts packages/agent-types/test/session.test.ts
git commit -m "feat(agent-types): add SessionStageAddendum"
```

---

### Task 11: Public surface — failing test

**Files:**
- Create: `packages/agent-types/test/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-types/test/index.test.ts
import { describe, expect, it } from 'vitest';
import * as api from '../src/index';

describe('public surface', () => {
  it('re-exports STAGES at runtime', () => {
    expect(api.STAGES).toBeDefined();
    expect(api.STAGES).toContain('processing');
  });

  it('exports the expected runtime value keys (and nothing else)', () => {
    // Types are erased at runtime; STAGES is the only runtime export.
    // This guards against accidentally exporting a runtime helper that
    // wasn't part of the spec.
    expect(Object.keys(api).sort()).toEqual(['STAGES']);
  });
});

// Compile-time check that every documented type is re-exported.
// If any name is missing or renamed, this file won't typecheck.
import type {
  Stage,
  ProgressEvent,
  ProgressEventType,
  AgentOutputPayload,
  ConversationTurn,
  UserInputSignal,
  SessionStageAddendum,
} from '../src/index';

describe('type re-exports', () => {
  it('is reachable through the package entry point', () => {
    // We only need to USE the types for the compile check to bite. The runtime
    // assertion below is incidental.
    const stage: Stage = 'processing';
    const eventType: ProgressEventType = 'agent_output';
    const ev: ProgressEvent = {
      sessionId: 's', turnId: 't', eventId: 'e', seq: 0,
      type: 'stage_transition', timestamp: 0,
    };
    const out: AgentOutputPayload = { content: 'x' };
    const turn: ConversationTurn = { role: 'user', content: 'x' };
    const sig: UserInputSignal = { turnId: 't', prompt: 'p', conversationHistory: [] };
    const add: SessionStageAddendum = {};

    expect({ stage, eventType, ev, out, turn, sig, add }).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- test/index.test.ts
```

Expected: FAIL with `Failed to resolve import "../src/index"`.

---

### Task 12: Public surface — implementation

**Files:**
- Create: `packages/agent-types/src/index.ts`

- [ ] **Step 1: Write the barrel file**

```ts
// packages/agent-types/src/index.ts

export { STAGES } from './stage';
export type { Stage } from './stage';

export type {
  ProgressEvent,
  ProgressEventType,
  AgentOutputPayload,
} from './progress';

export type {
  ConversationTurn,
  UserInputSignal,
} from './signal';

export type { SessionStageAddendum } from './session';
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: PASS, all 5 test files green (3 + 7 + 4 + 5 + 3 = 22 tests).

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-types/src/index.ts packages/agent-types/test/index.test.ts
git commit -m "feat(agent-types): export public surface via index.ts"
```

---

### Task 13: Build the package and verify `dist/` output

**Files:**
- Generated: `packages/agent-types/dist/*` (build artifact, not committed)

- [ ] **Step 1: Build the package**

Run from `packages/agent-types/`:

```bash
npm run build
```

Expected: no errors. `dist/` is created with `.js`, `.d.ts`, `.js.map`, and `.d.ts.map` files for each source file.

- [ ] **Step 2: Verify dist contents**

```bash
ls dist
```

Expected output (order may differ):

```
index.d.ts
index.d.ts.map
index.js
index.js.map
progress.d.ts
progress.d.ts.map
progress.js
progress.js.map
session.d.ts
session.d.ts.map
session.js
session.js.map
signal.d.ts
signal.d.ts.map
signal.js
signal.js.map
stage.d.ts
stage.d.ts.map
stage.js
stage.js.map
```

- [ ] **Step 3: Verify the built `dist/index.js` is consumable**

Run from `packages/agent-types/`:

```bash
node -e "const t = require('./dist/index.js'); console.log(t.STAGES);"
```

Expected:

```
[
  'thinking', 'queued', 'processing',
  'review',   'rework', 'sign-off',
  'done'
]
```

- [ ] **Step 4: Verify `dist/index.d.ts` declares the expected types**

```bash
cat dist/index.d.ts
```

Expected contents (whitespace may vary):

```ts
export { STAGES } from './stage';
export type { Stage } from './stage';
export type { ProgressEvent, ProgressEventType, AgentOutputPayload, } from './progress';
export type { ConversationTurn, UserInputSignal, } from './signal';
export type { SessionStageAddendum } from './session';
//# sourceMappingURL=index.d.ts.map
```

If the file is missing any of the type re-exports, fix `src/index.ts` and rebuild before continuing.

- [ ] **Step 5: Commit `package-lock.json` if it changed**

`dist/` itself is git-ignored; no source changes are needed.

```bash
git status packages/agent-types
```

If only `package-lock.json` changed, commit it:

```bash
git add packages/agent-types/package-lock.json
git commit -m "build(agent-types): lock devDependencies"
```

Otherwise skip the commit.

---

### Task 14: Wire workspace + repo-root scripts

**Files:**
- Modify: root `package.json`
- Modify: root `tsconfig.json`

- [ ] **Step 1: Read the current root `package.json`**

```bash
cat package.json
```

Take note of the existing `scripts` block; we add to it without removing anything.

- [ ] **Step 2: Add `workspaces` and a build/typecheck script for the package**

Edit `package.json` at the repo root. Add these two top-level keys (place `workspaces` right after `private`; if there is no `private` key, add `"private": true` too — the repo is already not published):

```json
  "private": true,
  "workspaces": ["packages/*"],
```

Inside `"scripts"`, add:

```json
    "build:types": "npm --workspace @threadbase/agent-types run build",
    "typecheck:types": "npm --workspace @threadbase/agent-types run typecheck",
    "test:types": "npm --workspace @threadbase/agent-types test"
```

The full `scripts` block should now look like (preserving every existing script):

```json
  "scripts": {
    "temporal:up": "docker compose up -d",
    "temporal:down": "docker compose down",
    "temporal:reset": "docker compose down -v",
    "worker": "tsx watch src/worker.ts",
    "kickoff": "tsx src/starter.ts",
    "typecheck": "tsc --noEmit",
    "build:types": "npm --workspace @threadbase/agent-types run build",
    "typecheck:types": "npm --workspace @threadbase/agent-types run typecheck",
    "test:types": "npm --workspace @threadbase/agent-types test"
  },
```

- [ ] **Step 3: Re-install at the repo root so workspaces hoist**

```bash
npm install
```

Expected: npm installs the workspace, creates a symlink under `node_modules/@threadbase/agent-types`, and updates `package-lock.json`.

- [ ] **Step 4: Verify the workspace link**

```bash
ls -la node_modules/@threadbase/agent-types
```

Expected: a symlink pointing at `../../packages/agent-types`.

- [ ] **Step 5: Run the new scripts to make sure they work end-to-end**

```bash
npm run build:types
npm run test:types
npm run typecheck:types
```

Expected: all three succeed; tests show all 22 green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(workspaces): add agent-types as a workspace package"
```

---

### Task 15: Smoke-test consumability via a temporary scratch import

**Files:**
- Create (then delete): `scratch/consume-types.ts`

This task proves a sibling project can consume the package via a `file:` dep. The scratch file is deleted at the end — its only purpose is the verification.

- [ ] **Step 1: Create the scratch directory and file**

```bash
mkdir -p scratch
```

Write `scratch/consume-types.ts`:

```ts
// Scratch consumer used once to verify the package is importable.
// This file is deleted at the end of this task. Do NOT commit it.

import {
  STAGES,
  type Stage,
  type ProgressEvent,
  type AgentOutputPayload,
  type ConversationTurn,
  type UserInputSignal,
  type SessionStageAddendum,
} from '@threadbase/agent-types';

const stage: Stage = 'processing';
console.log(`stages: ${STAGES.length}, current: ${stage}`);

const ev: ProgressEvent = {
  sessionId: 'sess_smoke',
  turnId: 'turn_smoke',
  eventId: 'evt_smoke',
  seq: 0,
  type: 'agent_output',
  timestamp: Math.floor(Date.now() / 1000),
  payload: { content: 'smoke', reviewerOverruled: false } satisfies AgentOutputPayload as unknown as Record<string, unknown>,
};

const turn: ConversationTurn = { role: 'user', content: 'hi' };
const sig: UserInputSignal = { turnId: 'turn_smoke', prompt: 'p', conversationHistory: [turn] };
const add: SessionStageAddendum = { stage: 'review', stalledSinceMs: 0 };

console.log('all imports resolved:', { ev: ev.eventId, sig: sig.turnId, add: add.stage });
```

- [ ] **Step 2: Typecheck the scratch file**

The root tsconfig currently has `"include": ["src/**/*.ts"]`. Run a one-shot typecheck against the scratch file explicitly:

```bash
npx tsc --noEmit --module CommonJS --moduleResolution Node --target ES2021 --esModuleInterop --strict scratch/consume-types.ts
```

Expected: no errors.

- [ ] **Step 3: Execute the scratch file via tsx**

```bash
npx tsx scratch/consume-types.ts
```

Expected output (timestamp will differ):

```
stages: 7, current: processing
all imports resolved: { ev: 'evt_smoke', sig: 'turn_smoke', add: 'review' }
```

- [ ] **Step 4: Delete the scratch file and directory**

```bash
rm -rf scratch
```

- [ ] **Step 5: Verify the working tree is clean**

```bash
git status
```

Expected: `nothing to commit, working tree clean`. (If anything in `scratch/` was accidentally staged earlier, unstage with `git restore --staged scratch && rm -rf scratch`.)

This task is verification-only; nothing to commit.

---

### Task 16: Final repo-level check

- [ ] **Step 1: Run the package's full test suite**

```bash
npm run test:types
```

Expected: 22 tests pass across 5 files.

- [ ] **Step 2: Run the package build**

```bash
npm run build:types
```

Expected: clean build, no errors.

- [ ] **Step 3: Run the package typecheck**

```bash
npm run typecheck:types
```

Expected: no errors.

- [ ] **Step 4: Run the existing top-level typecheck to make sure the workspace didn't break it**

```bash
npm run typecheck
```

Expected: no errors. (This typechecks the existing tb-multi-agent source under `src/`, which is unchanged.)

- [ ] **Step 5: Verify the package is the size we expect**

```bash
du -sh packages/agent-types/src
```

Expected: under 4 KB. If it's larger, something extra has been added beyond the spec — review and trim before continuing.

If all four steps pass, the package is shippable.

---

## Self-Review

1. **Spec coverage:** Every type in spec §3.3 has a task — `Stage`/`STAGES` (Tasks 3–4), `ProgressEvent`/`ProgressEventType`/`AgentOutputPayload` (Tasks 5–6), `UserInputSignal`/`ConversationTurn` (Tasks 7–8), `SessionStageAddendum` (Tasks 9–10), barrel re-exports (Tasks 11–12). Build + workspace wiring (Tasks 13–14). Cross-repo consumability proven (Task 15).
2. **Placeholder scan:** No TBDs, no "add appropriate error handling," no "similar to Task N." Every code step has the full code body. Every command has expected output.
3. **Type consistency:** `Stage`, `STAGES`, `ProgressEvent`, `ProgressEventType`, `AgentOutputPayload`, `ConversationTurn`, `UserInputSignal`, `SessionStageAddendum` — every name in later tasks matches the name introduced in its defining task. The barrel file in Task 12 lists exactly these names, no others. Task 15 imports them by these names.
4. **Out-of-scope creep:** This plan does NOT touch `src/` of tb-multi-agent (that's Plan 2) and does NOT touch tb-streamer (that's Plan 3). Confirmed.

---

## Hand-off

When this plan finishes, the next plan (Plan 2 — tb-multi-agent orchestrator wiring) can:

- Import from `@threadbase/agent-types` directly in workflow + activity code (it's already a workspace dep at the repo root).
- Use `STAGES` for runtime checks and `Stage` for type narrowing.
- Rely on the wire-shape contracts being type-checked everywhere they're constructed or consumed.
