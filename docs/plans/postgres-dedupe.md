# Deferred: Postgres-backed progress event dedupe (option D)

Status: deferred — not in milestone B. Captured here so we can reach for it without re-deriving the design.

## Context

Milestone B uses an in-memory dedupe map on tb-streamer's per-session record (option B). That is correct for best-effort UI events but has one known failure window: when tb-streamer restarts mid-session, the dedupe map is empty, so a Temporal activity that retries after the restart can deliver one duplicate event to the UI.

This document describes the upgrade path when that window stops being acceptable.

## When to upgrade

Pick D over B when any of these become true:

- Duplicated UI blocks during a deploy stop being acceptable (e.g. paying users, support tickets attributable to "I saw the same message twice").
- tb-streamer needs to scale to more than one process per session-routing region (multiple replicas serving the same `sessionId` would each maintain their own in-memory dedupe set).
- Auditing live progress delivery becomes a product requirement ("did the user actually see stage X at time T?").
- Long-running orchestrator workflows mean activity retries can land minutes or hours after the original (B's dedupe window is the session lifetime, but a tb-streamer restart shortens it to "since the restart").

## Design

A dedupe table in tb-streamer's existing Postgres database. tb-multi-agent does not change — the webhook contract is identical. This is a tb-streamer-internal upgrade.

### Schema

```sql
CREATE TABLE progress_events_seen (
  event_id    text PRIMARY KEY,
  session_id  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX progress_events_seen_received_at_idx
  ON progress_events_seen (received_at);
```

The unique primary key on `event_id` is what makes dedupe race-free under concurrency. The secondary index on `received_at` supports the sweep job.

### Handler change

The in-memory check is replaced by a single SQL statement:

```sql
INSERT INTO progress_events_seen (event_id, session_id)
VALUES ($1, $2)
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id;
```

If `RETURNING` yields a row, this is a new event — forward it to the WebSocket. If it yields nothing, this is a duplicate — drop it. No race conditions, no eviction policy to tune.

### TTL sweep

A daily job (cron, scheduled function, or pg_cron extension) deletes rows older than the retention window:

```sql
DELETE FROM progress_events_seen
WHERE received_at < now() - interval '24 hours';
```

24 hours is a pragmatic default: comfortably longer than any realistic Temporal activity retry window, short enough that the table stays small.

If row volume turns out to be high, switch to `PARTITION BY RANGE (received_at)` with daily partitions and `DETACH PARTITION` + `DROP TABLE` for sweep — avoids `DELETE` bloat.

## Why this stays orthogonal to tb-multi-agent

tb-multi-agent only knows the webhook contract: POST a signed JSON event with an `eventId`. How tb-streamer dedupes is invisible. Migrating from B to D requires zero changes on the worker side and is purely a tb-streamer-internal swap.

## Estimated cost to upgrade

- 1 migration file (add the table + index).
- ~15 lines swapping `Set.has`/`Set.add` for the upsert.
- A sweep job (a few lines, or one `pg_cron` row).
- Local-dev and test setup updates so the table exists.

## Out of scope here

- Cross-region session routing.
- Durable storage of the event *payloads* (events are still best-effort; this table only stores `event_id` for dedupe).
- Replacing the JSONL conversation history pipeline — that is the durable record and is unaffected.
