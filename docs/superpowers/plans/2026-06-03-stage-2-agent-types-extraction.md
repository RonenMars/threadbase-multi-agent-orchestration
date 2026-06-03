# Stage 2 — `@threadbase/agent-types` extraction to its own repo

**Date:** 2026-06-03 (planned), 2026-06-04 (executed)
**Status:** Completed
**Goal:** Move the `agent-types` package out of `tb-multi-agent/packages/agent-types/` into its own GitHub repo (`threadbase-agent-types`), and submodule it into both `tb-multi-agent` and `tb-streamer`. Removes the sibling-checkout requirement and fixes both repos' CI in one stroke.

**Execution outcome:**
- New repo: [RonenMars/threadbase-agent-types](https://github.com/RonenMars/threadbase-agent-types) at SHA `f8bfe43`.
- tb-streamer wired in commit `0b171cc` (PR #17, CI green).
- tb-multi-agent wired in commit `f9681a8` (PR #1, CI green).
- Both repos pin the same SHA; both CIs use `submodules: recursive`.

---

## Why now

- tb-streamer's CI on PR #17 is **red** because the symlink at `vendor/agent-types` points at a sibling checkout that doesn't exist in CI.
- The alternative (cloning tb-multi-agent in tb-streamer's CI) requires hardcoding a branch name in the workflow file, with ongoing maintenance burden as that branch name flips with each parallel feature branch.
- Stage 2 is reversible: when Stage 3 (npm publish) lands, deleting the submodule and adding a registry dep is a small refactor.

This decision reverses my earlier "stay on Stage 1" recommendation, which was made under the assumption that CI didn't exist. CI exists now and is broken; the cost analysis flipped.

---

## Decisions locked in

| Topic | Decision |
|---|---|
| Repo name | `threadbase-agent-types` (matches `threadbase-streamer`, `threadbase-multi-agent-orchestration`) |
| Visibility | Public (matches `threadbase-scanner`; contains only TypeScript types, no secrets) |
| License | MIT (matches tb-streamer) |
| Submodule URL format | HTTPS (per tb-streamer's CLAUDE.md guidance: SSH breaks on Windows) |
| Path in tb-streamer | `vendor/agent-types/` (mirrors `vendor/scanner`; replaces the current symlink) |
| Path in tb-multi-agent | `packages/agent-types/` (keep the workspace path; submodule lives there instead of native source) |
| Branch to submodule from | `main` of `threadbase-agent-types` |
| Initial commit content | Current state of `packages/agent-types/src/` + `test/` + `package.json` + `tsconfig.json` + `README.md` + `.gitignore`. No git history transfer (the package is days old). |

---

## Order of operations

Steps that touch GitHub or push commits are marked **[push]**. Steps that only edit local files are unmarked.

### Phase 1: Create the new repo

1. **[push]** Run `gh repo create RonenMars/threadbase-agent-types --public --description "Shared wire types for the Threadbase multi-agent pipeline" --license MIT`. Creates an empty repo with README and LICENSE.
2. Clone the new repo to a temp directory: `git clone https://github.com/RonenMars/threadbase-agent-types.git /tmp/threadbase-agent-types`.
3. Copy the current source into the temp clone:
   - `cp -R packages/agent-types/{src,test,package.json,tsconfig.json,.gitignore} /tmp/threadbase-agent-types/`
   - Replace the auto-generated README with the existing `packages/agent-types/README.md`.
4. Adjust `package.json` if needed (the existing one should be portable, but verify `private: true` stays — we're not publishing to npm yet).
5. In `/tmp/threadbase-agent-types`: `npm install`, `npm test` (should pass — 23 tests), `npm run build` (should produce `dist/`).
6. **[push]** Commit the initial source + push to main: `git add . && git commit -m "feat: initial extraction from tb-multi-agent" && git push`.

### Phase 2: Wire into tb-streamer

7. In `tb-streamer/feat/milestone-b-multi-agent`: remove the existing symlink: `git rm vendor/agent-types`.
8. Add the submodule: `git submodule add https://github.com/RonenMars/threadbase-agent-types.git vendor/agent-types`. This creates `.gitmodules` (or appends to it) and clones the repo into `vendor/agent-types/`.
9. Verify the submodule pins to the right commit: `git submodule status` should show the SHA from Phase 1's initial commit.
10. The submodule needs `npm install` and `npm run build` to produce `dist/`, since tb-streamer's tsup expects to bundle from `vendor/agent-types/dist/`. Add a `postinstall` step to tb-streamer's own postinstall chain, OR keep the existing `build:scanner` pattern (which runs `npm --prefix vendor/scanner install --no-audit --no-fund`) and add a parallel `build:agent-types` line.
11. Run tb-streamer's full test + lint + build locally. Verify nothing regresses.
12. **[push]** Commit: `git add .gitmodules vendor/agent-types package.json && git commit -m "build(agent-types): extract to submodule"`. Push.
13. Verify tb-streamer's CI on PR #17 turns green. If not, fix before proceeding to Phase 3.

### Phase 3: Wire into tb-multi-agent

14. In `tb-multi-agent/feat/milestone-b-implementation`: this is the riskier phase because tb-multi-agent is currently the source-of-truth holder.
15. **Verify first:** `git rev-parse HEAD:packages/agent-types/` should show the tree SHA. If anyone has uncommitted changes to agent-types here, capture them first.
16. Remove the tracked package: `git rm -r packages/agent-types`.
17. Add the submodule at the same path: `git submodule add https://github.com/RonenMars/threadbase-agent-types.git packages/agent-types`.
18. Verify the workspace declaration in root `package.json` still resolves: `"workspaces": ["packages/*"]` should pick up `packages/agent-types/`.
19. Run `npm install` at the root. This should rebuild the workspace symlink at `node_modules/@threadbase/agent-types`.
20. Run `npm run build:types` to produce the submodule's `dist/`. Run `npm run typecheck`, `npm test` (with `--exclude 'test/integration/**'`), `npm run test:types`. Everything should pass.
21. Update `.github/workflows/ci.yml` to add `submodules: recursive` to each `actions/checkout@v4` block.
22. **[push]** Commit: `git add .gitmodules packages/agent-types .github/workflows/ci.yml && git commit -m "build(agent-types): extract to submodule"`. Push.
23. Verify tb-multi-agent's CI on PR #1 stays green.

### Phase 4: Documentation

24. Update tb-streamer's CLAUDE.md to mention the new submodule alongside `vendor/scanner`.
25. Update tb-multi-agent's roadmap entry for "agent-types promotion" — mark Stage 2 done with the SHA / date.
26. Update the integration test README — the "How tb-streamer is consumed" section no longer needs the symlink narrative; both repos now submodule the same source.
27. **[push]** Single docs commit per repo. Mention this is post-Stage-2.

---

## Risks and how each one is handled

| Risk | Mitigation |
|---|---|
| Phase 2 breaks tb-streamer (typo in `.gitmodules`, wrong submodule URL) | Run lint+build+test locally BEFORE pushing. Don't push until green locally. |
| Phase 3 starts before Phase 2's CI is verified green | Explicit gate at step 13. If tb-streamer's CI fails, don't start Phase 3 — fix Phase 2 first. |
| Phase 3 deletes `packages/agent-types/` then submodule add fails | Verify the GitHub repo exists and the URL is reachable (`git ls-remote https://github.com/RonenMars/threadbase-agent-types.git`) BEFORE the `git rm`. |
| The submodule's `dist/` doesn't exist on CI fresh checkout | Same mitigation as for tb-multi-agent's existing CI fix (commit `9b7b8a7`): build before typecheck. Verify both repos' CIs have a "build agent-types" step. |
| Two-step submodule update workflow is unfamiliar | Document the bump pattern in both repos' READMEs (mirroring `vendor/scanner`'s existing docs). |
| Stage 2 work blocks other progress | Estimate: 2-3 hours of focused execution. Plan covers the work in 4 phases each of which is testable in isolation. Roll back any phase if it goes wrong. |

---

## Rollback plan

If something goes badly wrong during execution:

- **Phase 1 only:** delete the GitHub repo (`gh repo delete RonenMars/threadbase-agent-types --yes`). No other state changed.
- **After Phase 2:** in tb-streamer, `git revert <submodule-commit>` and force-push the feature branch. Restore the symlink approach. tb-streamer's CI stays red but tb-multi-agent is unaffected.
- **After Phase 3:** same revert in tb-multi-agent. Both repos return to Stage 1 state.

This is reversible at every step. The new GitHub repo can be deleted any time — its content is duplicated from tb-multi-agent's history.

---

## Out of scope (do NOT do in this work)

- npm publishing (that's Stage 3, bundled with the tb-streamer distribution refactor — see `docs/superpowers/specs/2026-06-03-tb-streamer-distribution-refactor.md`).
- Moving any OTHER files between repos. Just agent-types.
- Renaming the `@threadbase/agent-types` npm name.
- Changing the wire types themselves.
- Adding tooling (lint, format, additional tests) beyond what already exists in `packages/agent-types/`.

---

## What approval means

If you greenlight this plan, I execute Phases 1–4 in order, pausing for your confirmation at:

- Before Phase 1 step 1 (creating the GitHub repo — a public artifact, irreversible without `gh repo delete`).
- Before Phase 2 step 12 (first push that changes tb-streamer's submodule wiring).
- Before Phase 3 step 22 (first push that changes tb-multi-agent's source layout).

After each push, I verify CI before moving to the next phase. If CI fails, we fix before continuing.
