// Integration scenario 4 — HMAC rejection.
//
// Sends a progress event via direct HTTP fetch with three bad-signature
// variants:
//   - missing X-Progress-Signature header
//   - wrong signature (random hex)
//   - signature from a different secret
//
// Verifies for each:
//   - 401 response
//   - No broadcast to the WS sink
//   - No JSONL write
//
// Also sends one valid-signature event to confirm the route works when
// signatures are correct (regression guard).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { readdir } from "node:fs/promises";
import { nanoid } from "nanoid";
import { createTestRig, makeStubActivities, type TestRig } from "../harness";

const SECRET = "integration-secret";

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function postRaw(
  baseUrl: string,
  sessionId: string,
  body: object,
  signature: string | null,
): Promise<{ status: number }> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-progress-timestamp": String(Math.floor(Date.now() / 1000)),
    "x-progress-event-id": (body as { eventId: string }).eventId,
  };
  if (signature !== null) {
    headers["x-progress-signature"] = signature;
  }
  const res = await fetch(`${baseUrl}/internal/sessions/${sessionId}/progress`, {
    method: "POST",
    headers,
    body: raw,
  });
  return { status: res.status };
}

function makeEvent(sessionId: string, eventId: string) {
  return {
    sessionId,
    turnId: "turn-1",
    eventId,
    seq: 0,
    type: "agent_output" as const,
    stage: "done" as const, // would trigger JSONL write if accepted
    timestamp: Math.floor(Date.now() / 1000),
    payload: { content: "this should NOT be persisted" },
  };
}

describe("integration: HMAC rejection", () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = await createTestRig({
      activities: makeStubActivities({ reviewerApprovesAfter: 0 }),
    });
  });

  afterEach(async () => {
    await rig.teardown();
  });

  it(
    "rejects missing signature with 401, no broadcast, no JSONL",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const event = makeEvent(sessionId, "evt-no-sig");

      const res = await postRaw(rig.receiverUrl, sessionId, event, null);
      expect(res.status).toBe(401);
      expect(rig.sink.captured).toHaveLength(0);

      // conversationsDir should be empty (no JSONL file created).
      const files = await readdir(rig.conversationsDir);
      expect(files).toHaveLength(0);
    },
  );

  it(
    "rejects bogus signature with 401, no broadcast, no JSONL",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const event = makeEvent(sessionId, "evt-bogus-sig");
      const bogus = crypto.randomBytes(32).toString("hex");

      const res = await postRaw(rig.receiverUrl, sessionId, event, bogus);
      expect(res.status).toBe(401);
      expect(rig.sink.captured).toHaveLength(0);

      const files = await readdir(rig.conversationsDir);
      expect(files).toHaveLength(0);
    },
  );

  it(
    "rejects signature from a different secret with 401, no broadcast, no JSONL",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const event = makeEvent(sessionId, "evt-wrong-secret");
      const wrongSig = sign(JSON.stringify(event), "not-the-real-secret");

      const res = await postRaw(rig.receiverUrl, sessionId, event, wrongSig);
      expect(res.status).toBe(401);
      expect(rig.sink.captured).toHaveLength(0);

      const files = await readdir(rig.conversationsDir);
      expect(files).toHaveLength(0);
    },
  );

  it(
    "accepts a correctly-signed event (regression guard)",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const event = makeEvent(sessionId, "evt-good");
      const goodSig = sign(JSON.stringify(event), SECRET);

      const res = await postRaw(rig.receiverUrl, sessionId, event, goodSig);
      expect(res.status).toBe(200);
      expect(rig.sink.captured).toHaveLength(1);
    },
  );
});
