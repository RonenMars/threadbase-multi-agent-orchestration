# tb-streamer Distribution Refactor — Design Spec

**Date:** 2026-06-03
**Status:** Draft for review (no implementation work yet)
**Scope:** Re-architect tb-streamer's repository so consumable parts of its surface can be installed via `npm install` from a registry, instead of the current "deploy this whole binary" distribution model.

> **For the reader:** This is a sizing-and-design doc, not a per-task implementation plan. Goal is to give you enough detail to decide whether to invest, and if so, at what scope. The actual writing-plans work comes after you approve a scope.

---

## 1. Why this exists

The trigger was milestone B integration tests. `tb-multi-agent` wanted to import `createProgressRoutes` from tb-streamer to verify wire compatibility end-to-end. Every GitHub-based install path failed:

- **`github:RonenMars/threadbase-streamer#<sha>`** — npm clones without submodules; tb-streamer's `postinstall` runs `npm --prefix vendor/scanner install`; fails with ENOENT because `vendor/scanner/package.json` doesn't exist.
- **GitHub Release tarballs** — exist (v1.3.0 has them), but they're platform-specific binary distributions (~21 MB each, bundling native `node-pty` prebuilds) made for the streamer's own `update` command, not for npm consumption.
- **Vendoring into the test dir** — loses the "true integration test" property.

The proximate fix is to use a `file:../tb-streamer` dep locally and document the gap. The longer-term fix is what this doc is about: make tb-streamer's library surface a normal npm package that any consumer can install without cloning the whole repo, fetching submodules, or compiling native binaries they don't use.

This is not just an integration-test concern. The same problem will block:

- Anyone wanting to build a CLI plugin against tb-streamer's API types.
- Future repos (`tb-orchestrator`, hypothetical `tb-dashboard`) that need to consume the same types/route handlers tb-multi-agent does.
- External integrators who want to call tb-streamer's REST or WebSocket API and need typed clients.

---

## 2. What the current distribution actually is

| Distribution channel | Audience | What it ships | Status |
|---|---|---|---|
| **GitHub Release tarballs** (`threadbase-streamer-1.3.0-darwin-arm64.tgz`) | End users running tb-streamer as a daemon | Bundled CLI + native node-pty + better-sqlite3, ~21 MB | Working, automated via semantic-release |
| **Homebrew formula** (`brew install RonenMars/threadbase/tb-streamer`) | macOS/Linux end users | Same bundle wrapped for brew services | Working, auto-published on release |
| **`scripts/deploy.sh`** + variants | Self-hosted ops | Direct deploy from GitHub release tarballs | Working |
| **Auto-update** (in-process `threadbase-streamer update`) | Existing tb-streamer installations | Same release tarballs | Working |
| **npm registry** | Library consumers (us) | Nothing — `npmPublish: false` in semantic-release config | **GAP** |

The tarball-based distribution is mature and well-tooled. The npm-library distribution doesn't exist.

---

## 3. The library surface that needs to be consumable

Reading `tb-streamer/src/index.ts`, the current public exports are:

```ts
export { generateApiKey, loadOrCreateApiKey, validateApiKey } from "./auth";
export type { DbConfig } from "./db";
export { createPool, getDbConfig, isDbEnabled, maskConnectionString } from "./db";
export { discoverClaudeProcesses } from "./process-discovery";
export { PTYManager } from "./pty-manager";
export { StreamerServer } from "./server";
export { ConversationWatcher } from "./services/conversations/conversationWatcher";
export { SessionStore } from "./session-store";
export * from "./types";
export { WSHub } from "./ws-hub";
```

Investigating what each transitively requires:

| Export | Transitive native deps | Transitive heavy deps | Used by integration tests? |
|---|---|---|---|
| `generateApiKey`, `loadOrCreateApiKey`, `validateApiKey` | — | — | No (but tiny anyway) |
| `DbConfig`, `createPool`, `getDbConfig`, etc. | — | `pg` | No |
| `discoverClaudeProcesses` | — | — | No |
| `PTYManager` | **`node-pty`** | — | No |
| `StreamerServer` | **`node-pty`, `better-sqlite3`** | `hono`, `chokidar`, `pg`, scanner | No (test mounts a slim Hono app instead) |
| `ConversationWatcher` | **`better-sqlite3`** | `chokidar`, scanner | No |
| `SessionStore` | — | — | No (tests use a stub) |
| `types/*` | — | — | YES |
| `WSHub` | — | `ws` | YES (tests use a sink, not the real broadcast) |

The agent module is NOT in `index.ts` today but is what integration tests actually need:

| Agent export | Transitive native deps | Transitive heavy deps |
|---|---|---|
| `createProgressDedupeLRU` | — | — |
| `createConversationWriter` | — | — |
| `createAgentClient` | — | `@temporalio/client` (peer) |
| `readAgentConfig` | — | — |
| `createProgressRoutes` (route factory) | — | `hono`, `@threadbase/agent-types` |

**The agent module + types are completely free of native deps.** That's the natural seam for a small published package.

---

## 4. Three viable scopes

I'll be honest about cost and value for each. You picked "Big: full distribution refactor" earlier — laying out all three so you can confirm or adjust.

### Scope A — Minimal: publish the existing single package

**Change:** Flip `@semantic-release/npm.npmPublish` to `true`. Set `publishConfig.access: public`. Pre-build `dist/` during the release pipeline so the npm tarball includes it. Drop `vendor/scanner` from the `files` field (scanner is already bundled into `dist/` by tsup).

**Result:** `npm install @threadbase/streamer` works. Consumers get the full bundle — types, agent module, server, PTYManager, etc. Native deps (`node-pty`, `better-sqlite3`) install as dependencies on the consumer; if the consumer's platform has no prebuilds, they fail at install time.

**Pros:**
- Smallest change. Maybe 1-2 days of careful work.
- No new package boundaries to design.
- Existing API consumers continue to work unchanged.

**Cons:**
- Consumers who only want types pay for a 20+ MB install with native compilation.
- `node-pty` in CI environments without C++ toolchains will hard-fail. (Common: Vercel, Cloudflare, GitHub Actions on Windows.)
- "Library" and "binary" stay conflated. Future split is harder once the single-package contract has consumers.

**When this is right:** If you don't expect external integrators, and the only consumer is `tb-multi-agent`, this is fine. The "20 MB install" complaint is purely aesthetic if the only person installing it is you on a dev machine with prebuilds.

### Scope B — Mid: extract a thin `@threadbase/streamer-api` package

**Change:** Inside the tb-streamer repo, create `packages/streamer-api/` as a workspace. It contains:

- The full `src/agent/*` directory (agent-client, agent-config, conversation-writer, dedupe).
- `src/api/routes/progress.routes.ts` (the only route external consumers want).
- The relevant type subset: just the multi-agent wire types and the `WSMessage` variants for agent_output/turn_failure. The rest of `src/types.ts` stays in the main package.
- A new minimal `index.ts` that exports only the above.

The existing `@threadbase/streamer` package keeps everything else and *depends on* `@threadbase/streamer-api` for the agent surface. So PTY mode + multi-agent mode share types via a real package boundary.

**Result:** Two published npm packages. Integration tests install just `@threadbase/streamer-api` (no native deps). Downstream applications can wire the agent surface without pulling node-pty.

**Pros:**
- Clean separation. Agent surface is genuinely lightweight.
- Forces the wire contract to be a first-class artifact (the package version is the contract version).
- Path-of-least-resistance for adding more thin packages later (CLI types, dashboard types, etc.).

**Cons:**
- 3-5 days of careful work. The split itself is straightforward; the gotchas are in TypeScript project references, build wiring (tsup configs for both packages, or one shared), and ensuring the existing `dist/index.js` in the main package keeps working.
- Need to decide: does `@threadbase/streamer-api` ship runtime code, or is it types-only with the runtime in `@threadbase/streamer`? (Recommendation: runtime, because the dedupe LRU and progress route are real code worth sharing.)
- semantic-release config gets more complex with two packages. Either use `multi-semantic-release` or accept that the two packages move in lockstep.

**When this is right:** If you expect tb-streamer to grow (more routes, more consumers), this is the foundation. The split here is the one I'd do if I were writing this repo from scratch today.

### Scope C — Big: full multi-package architecture

**Change:** Split tb-streamer into 4-5 published packages along bounded-context lines. Approximate shape:

- `@threadbase/streamer-types` — pure types, zero deps. `WSMessage`, `SessionResponse`, all schemas.
- `@threadbase/streamer-api` — agent surface, progress route, dedupe, conversation writer.
- `@threadbase/streamer-pty` — PTYManager, process-discovery. Depends on node-pty.
- `@threadbase/streamer-cache` — ConversationCache, ConversationWatcher, repositories. Depends on better-sqlite3, chokidar.
- `@threadbase/streamer` — the existing all-in-one binary, now depending on the four packages above.

**Result:** Every consumer pays only for what they use. The CLI binary is the "everything bundled" choice for end users; library consumers pick the surface they need.

**Pros:**
- Future-proof architecture. Each package has one bounded context.
- Native deps isolated to the packages that need them.
- New surfaces (a dashboard? a Slack integration? a Discord bot?) become small additive packages, not new code in a monolith.
- Documentation and versioning become per-package — `@threadbase/streamer-cache` v3.0.0 means cache breaking changes; consumers know.

**Cons:**
- 2-4 weeks of focused work. Realistically more if it's part-time alongside milestone B.
- Heavy refactor of tsup configs. Each package needs its own build, but they share TypeScript project references for fast dev typechecking.
- Cross-package version management is non-trivial. Each release might touch one or several packages; semantic-release needs careful per-package config.
- Migration cost for `tb-streamer`'s own internal code — every existing import like `from "../session-store"` becomes `from "@threadbase/streamer-cache"`.
- The CLI bundle (`dist/cli.cjs`) now has to bundle from multiple packages instead of one. Manageable but adds complexity to the build pipeline that's already non-trivial (per the CLAUDE.md notes about migrations, externals, etc.).
- Risk of premature optimization. Until there are actual consumers of separated surfaces, the boundaries are speculative.

**When this is right:** If tb-streamer is going to be a platform with multiple independent consumers (dashboard, integration tests, CLI plugins, external integrations). If today's reality is "tb-streamer is mostly the binary and the integration test is the only library consumer we have," this is over-engineered.

---

## 5. Recommendation

I recommend **Scope B**, with **Scope A as a fallback if Scope B becomes a slog**.

Reasoning:

- **Scope A doesn't solve the underlying conflation problem.** It just papers over the install issue. As soon as a second non-binary consumer appears, you'd want Scope B anyway.
- **Scope C is real architecture work that should be motivated by real consumers**, not by an integration test. Today's count of non-binary consumers is one (tb-multi-agent). When it's three or four, revisit.
- **Scope B is the right size for the current problem.** It creates one new package with a clear bounded context (the agent/multi-agent surface) and leaves the rest of tb-streamer alone. If Scope B turns out to be the right shape long-term, you've spent 3-5 days; if you later need Scope C, the first split is done.

If you disagree with the recommendation, the strongest case for Scope C is: "I want a clean platform architecture and I'm willing to invest 2-4 weeks now to avoid retrofitting later." That's a valid call, just not what I'd pick.

---

## 6. Scope B — what the work actually is

If you greenlight Scope B, here's the breakdown. Each section is a rough "block of work" — a real plan would decompose them into the bite-sized tasks the `writing-plans` skill produces.

### 6.1 Package layout (~half a day)

Create `packages/streamer-api/` inside the tb-streamer repo. Wire up:

- `packages/streamer-api/package.json` — minimal, depends on `hono`, peer-deps `@temporalio/client`, no dep on `@threadbase/agent-types` (consumers bring their own — same as today's symlink situation).
- `packages/streamer-api/tsconfig.json` — composite project, declaration emits.
- Workspaces declaration in root `package.json`.
- Update root `tsconfig.json` with project references.

### 6.2 Move the code (~1 day, depends on test coverage)

Files to move from `tb-streamer/src/` to `packages/streamer-api/src/`:

- `agent/agent-client.ts`
- `agent/agent-config.ts`
- `agent/conversation-writer.ts`
- `agent/dedupe.ts`
- `api/routes/progress.routes.ts` (note: this is the load-bearing import)
- A new `types.ts` containing the agent-relevant subset of `src/types.ts` (the `Stage`, `WSMessage` variants for `agent_output`/`turn_failure`/extended `session_update`, `SessionStageAddendum`).

The existing `src/types.ts` in the main package re-exports from the new package to preserve backward compat.

Test files move correspondingly:

- `__tests__/agent/*.test.ts` → `packages/streamer-api/__tests__/`.

### 6.3 Rewire imports (~half a day)

In the main `@threadbase/streamer` package:

- `src/api/middleware/auth.middleware.ts` — no change.
- `src/api/app.ts` — change `import { createProgressRoutes } from "./routes/progress.routes"` to `import { createProgressRoutes } from "@threadbase/streamer-api"`.
- `src/server.ts` — `createAgentClient`, `createConversationWriter`, `readAgentConfig` imports come from `@threadbase/streamer-api` instead of `./agent/*`.
- `src/api/types/api-deps.ts` — `AgentClient`, `ConversationWriter`, `AgentConfig` type imports.
- `src/types.ts` — re-export agent types from `@threadbase/streamer-api`.
- `src/session-store.ts` — `ProgressDedupeLRU` import.

In `tb-multi-agent/test/integration/`:

- The README's "How tb-streamer is consumed" section becomes "install `@threadbase/streamer-api` from npm" instead of "GitHub SHA pin."

### 6.4 Build pipeline (~half a day)

The new package needs its own tsup config (or one shared). Output `dist/index.js` + `dist/index.cjs` + `dist/index.d.ts`. The main package's tsup config stays as-is.

Add a root-level `npm run build` that runs both. CI runs both. Existing `npm test` runs tests in both packages (`vitest` recognizes workspaces).

### 6.5 Publishing (~half a day)

Configure semantic-release to publish both packages. Two options:

- **Lockstep:** Both packages share a version. semantic-release stays single-config; on release, both packages publish at the same version. Simpler, but you may bump `@threadbase/streamer-api`'s version for changes that don't affect it.
- **Independent:** Each package has its own semantic-release config (via `multi-semantic-release` or per-package commits). More work, more accurate versioning.

Recommendation: lockstep for the first release. Switch to independent when version pressure builds.

Enable `npmPublish: true` in the streamer-api config. Set `publishConfig.access: public`. First publish requires `npm login` from a trusted CI environment or manual run.

### 6.6 Verification (~half a day)

- Existing tb-streamer test suite (~511 tests) passes unchanged.
- New `packages/streamer-api/__tests__/` suite passes (the moved agent tests).
- A consumer integration test in tb-multi-agent successfully installs `@threadbase/streamer-api` from `file:../tb-streamer/packages/streamer-api` and exercises the wire contract.

Once npm publish lands, repeat with the registry URL instead of `file:`.

### 6.7 Documentation (~half day)

- Update `tb-streamer/CLAUDE.md`'s "Dependencies" section.
- Add `packages/streamer-api/README.md`.
- Update `tb-streamer/README.md` to mention the two packages.
- Update `tb-multi-agent/test/integration/README.md` to drop the `file:` workaround and use the registry version.

### 6.8 Total estimate

**3-5 days of focused work**, assuming no major surprises in the build pipeline. The biggest risk is semantic-release's multi-package story; if it requires more refactoring than expected, scope can balloon. Mitigation: start with the move + rewire (the parts most under your control), defer publishing config to the end. If publishing is a nightmare, fall back to `file:` deps inside the monorepo and unblock integration tests, then solve publishing as a separate work item.

---

## 7. Risks and open questions

- **`npm publish` requires npm credentials in CI.** If you don't have an automation token set up for the `@threadbase` scope, that's prerequisite work. (Verify: does `@threadbase` org exist on npm? My earlier check said the scope returns 404 for `@threadbase/streamer`. That might mean the scope is unclaimed, or that no packages have been published yet. Investigate before depending on it.)
- **Renaming risk.** If `@threadbase` is unclaimed, anyone could claim it. Worth claiming proactively even before Scope B.
- **The agent surface in tb-streamer is two days old (per the milestone B plans).** Splitting it now means the split is happening at code that hasn't been battle-tested. May want to wait until integration tests are written *against the current monolithic shape* before refactoring — that way the tests survive the split as regression coverage.
- **Cross-repo type drift.** Currently `@threadbase/agent-types` is the source of truth for wire types, consumed by both tb-multi-agent and tb-streamer. If `@threadbase/streamer-api` *also* exports some of those types as re-exports, there's a small risk of import-cycle confusion. The package should re-export from agent-types, not redefine.
- **What's `tb-multi-agent`'s package story?** If we publish `@threadbase/streamer-api`, the symmetric move is to publish `@threadbase/agent-types` (currently a local file dep). Worth thinking about together, even if implemented separately.
- **Existing consumers of `@threadbase/streamer`.** None known — but if any internal scripts or CI workflows import from the main package, they need to keep working. The plan above preserves backward compat via re-exports, so this should be safe; verify nothing breaks.

---

## 8. Out of scope

- **Splitting `@threadbase/streamer-cache` or `@threadbase/streamer-pty`** — Scope C. Defer.
- **Auto-update changes.** The release pipeline keeps producing platform tarballs for the binary; npm publishing is additive.
- **Brew formula changes.** Same — additive.
- **Migrating any other repo** to consume `@threadbase/streamer-api`. tb-multi-agent's integration test is the first consumer; future repos are out of scope until they exist.

---

## 9. What approving this means

If you greenlight this design:

1. The next step is `writing-plans` on Scope B → produces a per-task implementation plan.
2. That plan goes into the tb-streamer repo's `docs/superpowers/plans/`, not tb-multi-agent's.
3. Execution proceeds on a feature branch of tb-streamer (`feat/streamer-api-extraction` or similar).
4. Milestone B integration tests **wait** for the extraction to land. The harness work I started gets revived once `@threadbase/streamer-api` exists.

If you'd rather not gate integration tests on this:

5. We do Scope A (or just go back to `file:../tb-streamer`) now, ship milestone B, do Scope B as a follow-up.

I want to flag option (5) explicitly because it's the path I'd advocate if I were optimizing for shipping milestone B. The integration tests don't *require* a clean distribution — they're useful even with an ugly `file:` dep. The distribution refactor is good work on its own merits, but it's not the gating problem for the feature.

---

## 10. Decision needed

Three things to confirm before I write a plan:

1. **Scope.** B, A, or C? (Recommendation: B.)
2. **Sequence.** Integration tests first (with `file:` dep), then refactor? OR refactor first, then integration tests? (Recommendation: integration tests first, both for momentum and to use them as regression coverage during the split.)
3. **Repo ownership.** This is tb-streamer work. The plan would live in tb-streamer's repo, not tb-multi-agent's. Same workflow, different working dir. Confirm you're good with that.
