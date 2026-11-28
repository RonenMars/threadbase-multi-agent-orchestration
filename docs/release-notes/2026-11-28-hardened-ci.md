# M6 hardened CI — every change is scanned, and skipping is decided by the diff

**Shipped:** 2026-11-28
**PR:** [#24 — ci: harden the pipeline with a diff-driven skip gate and scans](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/24)
**Squash commit on main:** `e29cf0f`

## What shipped

CI now decides from the changed files whether to run typecheck and tests, replacing the `[skip-ci]` text tag.
A new Scan job looks for committed secrets and audits production dependencies on every change.
Actions are pinned by commit SHA, and workflows read-only by default.
The worker, its wire contract and the streamer are unchanged.

## Why it matters

- **A code change can no longer be waved through.** Writing a tag in a title or description used to report the checks green without running them. Now only a change made entirely of listed files skips the suite.
- **Secrets are looked for even when tests are not run.** A key can land in a document as easily as in code, so the scan has no skip path.
- **CI runs the action code that was pinned.** Moving an action's tag no longer changes what runs here.

## Architecture

- **Gate** (`.github/workflows/ci.yml`, `.github/scripts/ci-skip.js`) — compares the change with its base and skips only when every changed file is in `.github/ci-skip-paths`. Both sides of a rename count. An empty change, or a diff that cannot be computed, runs the suite.
- **Scan** (`.github/workflows/ci.yml`) — gitleaks 8.30.1, verified by checksum, over the change's commits, or the whole history when there is no usable base. Then `npm audit --omit=dev`.
- **Workflow permissions** — `contents: read` by default. Only the release-notes reminder job can write to pull requests.
- **Concurrency** — each workflow has a group. In CI, a new push cancels a pull request's older run, and each push to `main` keeps its own.
- **Wire contract** — unchanged.

## User-visible behavior

Nothing changes for the phone or the streamer.
For contributors:

- `[skip-ci]` no longer does anything.
- A skipped run still reports the suite's checks as passed, with a "CI skipped" notice.
- Scan is a required check on `main`.
- Scan fails on a detected secret, including one removed by a later commit in the same change.
- Scan also fails when the audit finds a vulnerability, so a new advisory can fail a change that touched no dependency.

## Operator-facing details

- **Run command:** unchanged.
- **Required env:** unchanged.
- **Skip list:** `.github/ci-skip-paths` takes one exact path or `dir/**` per line. List only files that no build or test reads.
- **Dependencies:** the audit started clean because [#23](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/23) upgraded Temporal first.

## Tests

- **Skip gate** — `test/ci/skip.test.ts` covers the script.
- **Suite** — `npm test` passes 185 tests in 27 files, locally and on Node 20 and 22 in CI. The 7 integration scenarios already ran in CI before this milestone.
- **Mutant check** — 5 of 6 mutants of the skip script caught. The survivor removes the comment filter, which has practically no effect on the result.
- **Secret scan** — locally, gitleaks exits 0 on a clean tree and 1 on a fake secret, including one removed in a later commit. In CI it passed on this change. A failing scan has not been run on GitHub.
- **End-to-end** — on #24 the Gate ran the suite and Scan passed. On the docs-only [#25](https://github.com/RonenMars/threadbase-multi-agent-orchestration/pull/25), typecheck and tests were skipped while Scan ran and passed.

## Breaking changes

**None** for the worker. The `[skip-ci]` tag is removed.

## Deferred

Nothing deferred.
