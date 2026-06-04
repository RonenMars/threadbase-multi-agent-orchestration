# Release notes

This directory holds **milestone-level release notes** for the
`tb-multi-agent` Temporal worker repo. Each file captures the human story
of a milestone — what shipped, why it matters, what's deferred, and any
breaking changes — in user/operator-facing prose.

Release notes complement (not replace) the git history. The git log
records every commit; release notes record what those commits *mean* at
the milestone level.

## When to write them

At **milestone-merge time**, not after. The notes should ride into `main`
in the same PR (or an adjacent PR) as the milestone itself, so a reader
walking the repo can find the narrative next to the code that shipped it.

Routine work — bug fixes, dependency bumps, doc tweaks, single-feature
PRs — does not get release notes. Those live in the git log.

## Filename convention

```
YYYY-MM-DD-<kebab-milestone-name>.md
```

Examples:

- `2026-06-04-milestone-b.md`
- `2026-07-15-streaming-overhaul.md`

The date is the milestone-merge date (UTC). The kebab name is whatever
the team has been calling the milestone in chat / planning docs.

## Template

Start from [`_template.md`](./_template.md). It mirrors the section
structure of the existing notes files (`What shipped`, `Why it matters`,
`Architecture`, `User-visible behavior`, `Operator-facing details`,
`Tests`, `Breaking changes`, `Deferred to next milestone`, `Related work
in tb-streamer`).

The [`write-release-notes`](../../.claude/skills/write-release-notes/SKILL.md)
project-local skill drafts a new notes file from this template
automatically. Invoke it in Claude Code as `/write-release-notes` (or
mention the milestone name in conversation — the skill self-triggers on
milestone signals).

## CI reminder

Adding the `milestone` label to a PR triggers
[`.github/workflows/release-notes-reminder.yml`](../../.github/workflows/release-notes-reminder.yml).
The Action posts a sticky comment if the PR doesn't include a new
release-notes file. **It does not block merge** — it's a nudge, not a
gate.

To silence the reminder for a non-milestone PR that got the label by
accident, just remove the `milestone` label.

## Cross-repo

This milestone narrative often pairs with `tb-streamer`'s matching notes
file at `threadbase-streamer/docs/release-notes/<same-date>-<same-name>.md`.
Link it under "Related work in tb-streamer" in the notes body.
