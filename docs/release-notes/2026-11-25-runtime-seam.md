# M3 runtime seam and roles — agents can work in the session's repo

**Shipped:** 2026-11-25
**PR:** [#17 — feat(runtimes): run agent roles behind a runtime seam with an agent sdk runtime](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/17)

## What shipped

Every agent now runs behind one `AgentRuntime` seam, and `roles.yaml` says which runtime each role uses.
Two runtimes ship: `text`, today's single model call moved behind the seam, and `agent-sdk`, a Claude Agent SDK session that works inside the session's project directory with the tools its role allows.
`orchestratorWorkflow` takes an optional second argument, `{ projectPath }`, passes it to every turn, and carries it across continue-as-new.
Both shipped roles stay on `text`, so turns behave exactly as before until a role is switched in `roles.yaml` and the streamer sends a path.

## Why it matters

- **Agents can read the code they are asked about.** Until now the worker and reviewer only saw the prompt text; an `agent-sdk` role can open, search and list files in the user's repo, and, if its role allows, edit them.
- **Switching a role is a config edit, not a code change.** Model, prompt, tools, budget and turn limit live per role in `roles.yaml`, which is read on every turn.
- **A repo session cannot reach the machine's secrets.** The session loads no settings, hooks or MCP config from the repo, gets a stripped environment, and a guard refuses `.env` files, key files, credential folders, the streamer's own config, and `/proc`; Grep output has secret files' lines removed.
- **A runaway session is cheap to stop.** Each role has its own budget and turn limit, the activity heartbeats while the session works, and a session that hits its own limit fails without a retry.

## Architecture

- **`orchestratorWorkflow`** (`src/threadbase/orchestrator.ts`) — the second argument becomes `{ queue?, projectPath? }`. The path goes to each `pipelineWorkflow` child and into the `continueAsNew` call.
- **`pipelineWorkflow`** (`src/threadbase/pipeline.ts`) — when a path is set, a `roleRuntimes` local activity reads which runtime each role uses, and each agent call goes through the matching timeout tier: 5 minutes for `text`, 30 minutes with a 60-second heartbeat timeout and 2 attempts for `agent-sdk`. Without a path the turn records the same commands as before.
- **`processTask` / `reviewTask`** (`src/activities/agents.ts`) — names unchanged, so recorded histories replay. A new optional second argument `{ role, cwd? }` picks the role. An `agent-sdk` role with no path runs as `text`, and the draft carries a note the pipeline sends once as `agent_output`. The reviewer asks the `agent-sdk` runtime for a structured verdict and keeps the old JSON parse for `text`.
- **`src/runtimes/`** — `index.ts` (the seam), `text.ts`, `agent-sdk.ts`, `heartbeat.ts` (heartbeat, abort on cancel, one live session per workflow and directory, limits made non-retryable) and `secrets.ts` (tool guard, Grep redaction, log masking).
- **`roles.yaml`, `src/roles.ts`** — the roles and their loader; an unknown role runs as `text`, an unknown runtime throws.
- **Dependencies** — adds `@anthropic-ai/claude-agent-sdk` and `yaml`; `@anthropic-ai/sdk` moves from 0.40 to 1.x, which the Agent SDK requires.
- **Wire contract** — unchanged. The extra start argument is optional, and no event, signal or query changes name or shape.

## User-visible behavior

- None with the shipped roles.
- Once a role runs on `agent-sdk` and the streamer sends no path, the turn shows one extra agent message: "The worker has no project directory for this session, so it ran without tools."

## Operator-facing details

- **Run command:** unchanged, `npm run worker`.
- **Required env:** unchanged.
- **Optional env:** `ROLES_FILE` (default: `roles.yaml` at the repo root); `THREADBASE_CONFIG_DIR` (default: `~/.threadbase`), the streamer config folder the guard refuses.
- **Logging:** `processTask start` and `reviewTask start` gain `role` and `cwd`; `processTask done` carries the runtime's stats (turns, cost, session id and denied tools for `agent-sdk`; token counts and stop reason for `text`); agent-sdk stderr is logged at debug level with secret values masked.
- **Deploy order:** roll the new worker out everywhere before the streamer starts sending `projectPath`; a turn with a path records a `roleRuntimes` marker that an older worker cannot replay.

## Tests

- **Runtimes** — `test/runtimes/`: the secret guard's allow and deny lists, Grep redaction and masking; the roles loader; the agent-sdk options, structured output, hooks, limit and abort handling against a mocked SDK; routing between runtimes; the heartbeat wrapper.
- **Workflow** — `test/workflows/project-path.test.ts`: the path reaches each call and picks the 30-minute tier, and the child history replays; with no path there is no runtime lookup, the tiers stay at 5 minutes and the note shows once across a rework; the path survives continue-as-new.
- **Existing suites** — unchanged and passing, replay fixtures included: `npm test` runs 21 files / 129 tests.
- **Mutant check** — 33 mutants on the changed lines, all killed.
- **Agent SDK probe** — a real session on a scratch repo with a read-only allowlist read a file, was refused a write and a `.env` read, and returned search results without the `.env` line. The probe found that Grep returned the `.env` line before redaction existed; that is the fix shipped here.

## Breaking changes

**None.**

## Deferred to M4

- Both roles stay on `text`; switching one to `agent-sdk` waits for the streamer to send `projectPath`.
- The text runtime reports a cost of 0; per-turn spend lands with the M5 spend cap.
- The `Bash` guard matches command text, so it is a tripwire rather than a boundary; no shipped role gets `Bash`, and an OS sandbox is the upgrade if one needs it.
- Log masking covers the worker's own secret values; a repo's `.env` values are kept out by the read guard and Grep redaction instead.
- See `docs/ROADMAP.md` for the broader sequencing.

## Related work in tb-streamer

- [`threadbase-streamer` PR #1329 — feat(agent): pass the session's project path to the orchestrator workflow](https://github.com/RonenMars/threadbase-streamer/pull/1329): the agent start body takes an optional `path`, resolved like a PTY start, and sends it as `projectPath`.
