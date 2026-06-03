# Signed HTTP Webhook for tb-streamer Progress Events

## Overview

The best fit for the multi-agent progress side-channel is a signed HTTP webhook from the worker process to `tb-streamer`. It is the smallest mechanism that still gives you:

- Addressability by `sessionId`.
- Authenticated internal delivery using HMAC.
- Low latency with very low deployment overhead.
- Best-effort semantics with duplicate tolerance.

This approach matches the architecture of Threadbase well because the worker is already the source of progress events, while `tb-streamer` is the process that owns the WebSocket connection to the user.

## Why this is the right choice

Your workload is tiny: only a few small JSON events per turn, with one interested consumer per session. You do not need fan-out, replay, or a durable event log in the transport layer. A webhook is simple to deploy, easy to secure, and easy to make idempotent.

Compared with Redis pub/sub, this avoids adding new infrastructure. Compared with Temporal Update plumbing, it avoids pushing UI notification concerns back through workflow state. Compared with Postgres LISTEN/NOTIFY, it avoids depending on a database topology that tb-streamer does not already own.

## Suggested API shape

Use an internal endpoint on `tb-streamer` such as:

```http
POST /internal/sessions/:sessionId/progress
Content-Type: application/json
X-Progress-Signature: <hmac>
X-Progress-Timestamp: 1717430000
X-Progress-Event-Id: evt_123
```

Example payload:

```json
{
  "sessionId": "sess_abc",
  "turnId": "turn_001",
  "eventId": "evt_123",
  "seq": 2,
  "type": "stage_transition",
  "stage": "review",
  "timestamp": 1717430000,
  "payload": {
    "message": "Reviewer is inspecting the draft"
  }
}
```

## Event types

A small, fixed event vocabulary is enough:

- `stage_transition`: indicates a workflow stage change such as `drafting`, `review`, `signoff`, or `failed`.
- `agent_output`: carries a discrete output block from the worker, reviewer, or sign-off agent.
- `terminal_failure`: indicates that the workflow has exhausted retries or failed permanently.

If you want a separate event for partial streaming output later, keep the same envelope and add a new `type` value.

## Worker implementation

The worker should call the webhook from the activity code or from a helper used by the activity. Keep the request small and fail fast.

Implementation steps:

1. Build the event envelope.
2. Serialize the raw JSON body.
3. Compute an HMAC over the raw body using a shared secret.
4. Send the request to `tb-streamer` over HTTPS.
5. Treat delivery as best-effort.
6. Let Temporal retry the activity if the activity itself fails; the webhook handler must tolerate duplicates.

Example TypeScript sketch:

```ts
import crypto from 'crypto';

function signPayload(rawBody: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function sendProgressEvent(url: string, secret: string, event: unknown) {
  const rawBody = JSON.stringify(event);
  const signature = signPayload(rawBody, secret);

  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-progress-signature': signature,
      'x-progress-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-progress-event-id': (event as any).eventId,
    },
    body: rawBody,
  });
}
```

### Worker guidance

- Do not block the LLM call on webhook success.
- Do not retry aggressively at the transport level unless you explicitly want a short retry window.
- If the activity is retried by Temporal, the same event may be emitted again.
- Include a stable `eventId` so the receiver can dedupe.

## tb-streamer implementation

`tb-streamer` should expose one internal route that accepts the progress event, verifies the signature, dedupes the event, and forwards it to the correct WebSocket session.

Implementation steps:

1. Read the raw request body before JSON parsing.
2. Verify the HMAC signature using the shared secret.
3. Verify the timestamp is within an acceptable skew window.
4. Check whether the `eventId` or `(sessionId, turnId, seq)` has already been processed.
5. Store the event in the existing in-memory/session state.
6. Forward the event to the connected WebSocket client.

Example Node/Express-style sketch:

```ts
import crypto from 'crypto';
import express from 'express';

const app = express();
app.use('/internal', express.raw({ type: 'application/json' }));

function verifySignature(rawBody: Buffer, signature: string, secret: string) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const seen = new Set<string>();

app.post('/internal/sessions/:sessionId/progress', (req, res) => {
  const sessionId = req.params.sessionId;
  const signature = String(req.header('x-progress-signature') || '');
  const rawBody = req.body as Buffer;

  if (!verifySignature(rawBody, signature, process.env.PROGRESS_HMAC_SECRET!)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const event = JSON.parse(rawBody.toString('utf8'));
  const eventKey = event.eventId || `${event.sessionId}:${event.turnId}:${event.seq}`;

  if (seen.has(eventKey)) {
    return res.status(200).json({ ok: true, deduped: true });
  }

  seen.add(eventKey);

  // Route to the live websocket session for this sessionId.
  // wsManager.emitToSession(sessionId, event);

  return res.status(200).json({ ok: true });
});
```

## Deduplication strategy

Duplicates are expected, not exceptional. Activities can be retried by Temporal, and a retried activity may emit the same progress event again.

Recommended dedupe rule:

- Prefer a globally unique `eventId`.
- If you need ordering within a turn, also use `seq`.
- If you need a fallback, dedupe by `(sessionId, turnId, type, seq)`.

Keep the dedupe cache bounded. A small TTL cache or LRU is enough because the event volume is low and the events are short-lived.

## Security guidance

Use HTTPS for the worker-to-`tb-streamer` call. Keep the shared secret in environment variables or a secrets manager, and rotate it like any other internal credential.

Recommended checks:

- Verify the HMAC signature over the raw bytes.
- Reject missing or malformed signatures.
- Reject stale timestamps outside a short skew window.
- Keep the endpoint internal-only, even if it is also authenticated.
- Avoid putting secrets in the URL.

## Failure behavior

This channel should be best-effort. If `tb-streamer` is down, the worker may fail to deliver a progress event, and that is acceptable because the durable record lives elsewhere.

Practical rules:

- If the webhook call fails, log it and continue.
- Do not fail the user-visible workflow just because a progress notification was missed.
- If the final answer still needs to be shown, rely on the JSONL persistence pipeline and the normal workflow state query path.
- Let the frontend fall back to the workflow stage query when live progress is missing.

## Deployment notes

This option adds no new infrastructure services. You only need:

- A new internal HTTP endpoint in `tb-streamer`.
- A small webhook client in the worker.
- A shared HMAC secret.
- A dedupe cache in `tb-streamer`.

That is why this is the smallest solution that still fits the architecture.

## Recommended event contract

Keep the contract small and stable:

- `sessionId`: route key.
- `turnId`: groups events for one user message.
- `eventId`: unique identifier for dedupe.
- `seq`: ordering within a turn.
- `type`: `stage_transition`, `agent_output`, or `terminal_failure`.
- `timestamp`: event creation time.
- `payload`: event-specific data.

This is enough for the UI to show stage state and render discrete chat blocks without changing the existing WebSocket shape.

## Bottom line

Use a signed HTTP webhook as the progress side-channel. It is the simplest authenticated cross-process transport that fits your low-volume, one-to-one event flow, while staying compatible with Temporal retries and your existing `tb-streamer` architecture.
