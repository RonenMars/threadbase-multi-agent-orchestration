# CLAUDE.md

Project-specific guidance for Claude Code working in this repo
(`tb-multi-agent` — the Threadbase Temporal worker).

## Release notes

Milestone-level release notes live in `docs/release-notes/YYYY-MM-DD-<milestone>.md`. They are separate from any auto-generated CHANGELOG and capture the human story of what shipped, why it matters, and what's deferred.

When a milestone is ready to merge, invoke the project-local `write-release-notes` skill (at `.claude/skills/write-release-notes/`) to draft them. Add the `milestone` label to the merge PR — a GitHub Action will post a reminder if release notes are not present.
