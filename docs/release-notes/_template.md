# <Milestone name> — <short tagline>

**Shipped:** <YYYY-MM-DD>
**PR:** [#<number> — <PR title>](<PR URL>)
**Squash commit on main:** `<short SHA>`

## What shipped

<One-paragraph plain-English summary of what landed. Name the user-visible
artifact (a new workflow, a new wire contract, a new operator-facing CLI,
etc.) and state how it fits into the broader system. Mention cross-repo
dependencies if any (tb-streamer, @threadbase/agent-types).>

## Why it matters

<Original prose — NOT a commit-list rehash. Frame in user/operator terms:
what couldn't be done before, what's now possible, what pain is gone. Two
or three short bullets are fine if they each carry their own thought. Avoid
restating the "What shipped" paragraph.>

- <reason / capability / pain point #1>
- <reason / capability / pain point #2>
- <reason / capability / pain point #3>

## Architecture

<List the workflows, activities, packages, and wire-contract changes that
landed. Keep it tight — readers will dig into the code for detail. Examples
of what to mention for this Temporal worker repo:>

- **`<workflowName>`** — <one-line role; long-lived vs one-shot; what it owns>
- **`<activityName>`** — <one-line role; LLM call vs side-effect>
- **Wire contract** — <any change to `@threadbase/agent-types` or HMAC payloads>

## User-visible behavior

<What mobile clients / operators / dashboards actually observe. For this
repo, that's typically the WebSocket message stream the streamer broadcasts
on behalf of the worker.>

- <event / message / stage transition / env-var change #1>
- <event / message / stage transition / env-var change #2>

## Operator-facing details

- **Run command:** <e.g., `npm run worker`>
- **Required env:** <list new or changed env vars; mark which must match the streamer>
- **Optional env:** <list opt-in env vars and their defaults>
- **Logging:** <pino changes; new log fields; new log levels>

## Tests

- **Unit + workflow tests** — <what was added; which workflows/activities are covered>
- **Integration tests** — <cross-repo scenarios if any; mention `test/integration/`>
- **End-to-end smoke** — <runbook reference; pre-merge smoke result>

## Breaking changes

<Explicit list, or `**None.**` — never omit this section.>

## Deferred to <next milestone name>

<Explicit list of work that was scoped out. Link `docs/ROADMAP.md` for the
broader sequencing. If nothing is deferred, write a one-line
"Nothing deferred." statement.>

- <deferred item #1 — why deferred / what unblocks it>
- <deferred item #2 — why deferred / what unblocks it>

## Related work in tb-streamer

<Cross-repo PRs that ship the streamer side of this milestone. Remove this
section if the milestone is worker-only.>

- [`threadbase-streamer` PR #<number> — <title>](<URL>)

<Optional pointer to the streamer's matching release-notes file:>
The streamer's release notes for the same milestone are at `threadbase-streamer/docs/release-notes/<YYYY-MM-DD>-<kebab-milestone-name>.md`.
