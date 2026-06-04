---
name: write-release-notes
description: Draft milestone-level release notes for the tb-multi-agent Temporal worker repo. Use when shipping a named milestone (e.g., "Milestone B", "Milestone C", "Auth refactor") — invoke after the final commit lands on the feature branch but before the merge-to-main PR is merged. Auto-detects scope from git history and open milestone PRs, drafts into `docs/release-notes/YYYY-MM-DD-<kebab-name>.md` using the project template, and opens a draft PR on a `docs/<milestone-name>-release-notes` branch. Do not invoke for routine commits, bug fixes, or non-milestone work.
---

# Write release notes

## Overview

This skill produces a milestone release-notes markdown file for the `tb-multi-agent` Temporal worker repo (companion to `tb-streamer`). The artifact is a single file at `docs/release-notes/YYYY-MM-DD-<kebab-milestone-name>.md` that captures the human narrative of what shipped, why it matters, what's deferred, and any breaking changes — separate from any auto-generated CHANGELOG or raw git log.

The output is a draft PR on a `docs/<milestone-name>-release-notes` branch, ready for human review and merge.

## Why this exists

Milestone-level work in this repo (Milestone B, Milestone C, etc.) ships across multiple commits and often crosses repo boundaries (tb-streamer + tb-multi-agent). The git log alone doesn't tell a reader what changed in user-visible terms or why the work matters. Release notes fill that gap. Doing them by hand is fine; doing them inconsistently is not. This skill enforces the convention.

## When to use

Invoke when **all** of the following are true:

- The user names a milestone or scope-level effort (e.g., "Milestone B", "the auth refactor", "the streaming overhaul").
- The work is implemented — the final commit is on the feature branch.
- The merge-to-main PR has not yet been merged (so the notes can ride into main with the milestone, not as an afterthought).

Trigger phrases include: "write release notes for Milestone X", "draft milestone notes", "we're about to merge Milestone Y — do the notes", "run /write-release-notes".

## When NOT to use

- Routine commits, single bug fixes, dependency bumps, doc-only changes.
- Anything the user hasn't tagged as a milestone. **This skill must not run autonomously without a milestone signal from the user.**
- Patch-level releases against an already-merged milestone (those go in a follow-up notes file only if user-visible behavior changed).

## Anti-patterns

- **Do not** write notes for non-milestone work. A bug-fix PR is not a milestone.
- **Do not** just paste or lightly-rephrase the commit log. Commit-message prose rots into bullet sludge; the "Why it matters" section must be original, user-facing prose.
- **Do not** promise behavior that isn't in the commits. If the commit range doesn't ship a feature, don't list it. Cross-check every claim against `git log` and the actual diff.
- **Do not** skip the human-prose sections ("Why it matters", "User-visible behavior"). A notes file that's only headings and bullet lists is a CHANGELOG, not release notes.
- **Do not** push to `main` directly. **Do not** skip the human approval step before committing.

## The process

Run these steps in order. Stop and ask the user if any step's input is ambiguous.

### 1. Get the milestone name

If the user hasn't supplied a milestone name, ask: *"What's the milestone name? (e.g., 'Milestone C', 'streaming overhaul')"*. Convert to kebab-case for the filename (e.g., `Milestone C` → `milestone-c`).

### 2. Auto-detect scope

Find the commit range to cover:

```bash
# Find the most recent prior release-notes file.
ls -t docs/release-notes/*.md 2>/dev/null | grep -v '_template.md\|README.md' | head -1
```

- **If a prior notes file exists**, get its first commit on main:
  ```bash
  LAST_NOTES_COMMIT=$(git log --diff-filter=A --format=%H -- docs/release-notes/YYYY-MM-DD-prev.md | tail -1)
  git log --oneline "$LAST_NOTES_COMMIT..HEAD"
  ```
- **If no prior notes file exists**, walk all commits on the current branch since it diverged from `main`:
  ```bash
  git log --oneline main..HEAD
  ```

Also gather PR context:

```bash
# Open PRs labeled milestone
gh pr list --label milestone --json number,title,body,headRefName

# Merged PRs since the last notes file (adjust date as needed)
gh pr list --state merged --search "merged:>=YYYY-MM-DD" --json number,title,body,mergedAt
```

For each commit / PR, note: what changed (feature/fix/refactor/docs), the user-facing impact (or "none — internal only"), and which workflow or activity it touches if relevant (this is a Temporal worker — orchestrator workflow, turn workflow, processTask, reviewTask, sendProgressEvent, etc.).

### 3. Read the template

```bash
cat docs/release-notes/_template.md
```

Mirror its section structure exactly. Do not invent new top-level sections without reason.

### 4. Draft the file

Write to `docs/release-notes/YYYY-MM-DD-<kebab-milestone-name>.md` using today's date (`date -u +%Y-%m-%d`).

Fill every placeholder. For a Temporal-based worker repo, the sections will typically cover:
- **What shipped** — one paragraph plain English.
- **Why it matters** — original prose, user/operator perspective, not commit-list rehash.
- **Architecture** — workflows + activities touched, wire-contract changes if any.
- **User-visible behavior** — what mobile/client/operator observes (WebSocket events, stage transitions, new env vars, CLI changes).
- **Operator-facing details** — env vars, run commands, logging changes.
- **Tests** — unit/workflow/integration coverage added.
- **Breaking changes** — explicit "None." if none.
- **Deferred to next milestone** — explicit; link `docs/ROADMAP.md` where relevant.
- **Related work** in `tb-streamer` (cross-repo PRs) if applicable.

### 5. Self-review against this checklist

Walk through every item before showing the diff to the user:

- [ ] No placeholders remain (`TBD`, `TODO`, `fill in`, `<...>`, `XXX`).
- [ ] Every commit in the range is either represented in the notes or explicitly skipped with a one-line reason in your chat reply to the user (do not silently omit).
- [ ] The "Why it matters" section is user/operator-facing prose, not a commit list.
- [ ] Deferred-to-next-milestone items are listed explicitly. If nothing is deferred, say so.
- [ ] Breaking changes are called out. If none, write `**None.**` — do not omit the section.
- [ ] No claim in the file lacks a backing commit. Cross-check each feature/fix bullet against `git log` for the range.
- [ ] Cross-repo references (tb-streamer PRs) are linked if the milestone spans repos.
- [ ] Filename follows `YYYY-MM-DD-<kebab>.md` exactly.

### 6. Show the user and await approval

Show the proposed filename and the full diff:

```bash
git diff --no-index /dev/null docs/release-notes/YYYY-MM-DD-<kebab>.md
```

State which commits were covered and which (if any) were intentionally skipped. **Wait for explicit approval before proceeding.**

### 7. Commit on a docs branch

```bash
git checkout -b docs/<milestone-name>-release-notes
git add docs/release-notes/YYYY-MM-DD-<kebab>.md
git commit -m "docs(release-notes): add <milestone-name> notes"
```

Conventional-commit format is mandatory (the user's hook will reject non-conforming messages). No co-author trailers.

### 8. Push and open a draft PR

```bash
git push -u origin docs/<milestone-name>-release-notes
gh pr create --draft --title "docs(release-notes): add <milestone-name> notes" --body "$(cat docs/release-notes/YYYY-MM-DD-<kebab>.md)"
```

Add the `milestone` label if the user wants the reminder Action to mark it satisfied:

```bash
gh pr edit --add-label milestone
```

Report the PR URL back to the user.

## What NOT to do

- **Do not** invoke this skill autonomously without a milestone signal from the user.
- **Do not** push directly to `main`.
- **Do not** skip step 6 (approval). The user must see the diff first.
- **Do not** bypass the conventional-commit hook or add a `Co-Authored-By` trailer.
- **Do not** edit prior release-notes files. Each milestone gets its own file; corrections to prior milestones go in the next milestone's "Corrections" subsection (add the heading if needed).
