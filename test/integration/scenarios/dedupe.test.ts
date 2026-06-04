// Integration scenario 2 — dedupe.
//
// Sends the same eventId twice via direct HTTP fetch (bypassing the workflow,
// so we control the eventId). Verifies:
//   - First POST broadcasts and returns 200 { ok: true }.
//   - Second POST returns 200 { ok: true, deduped: true } and does NOT broadcast.
//
// This exercises the per-session dedupe LRU on tb-streamer's session record
// (spec §7.1). The workflow side's contribution to dedupe (workflow.uuid4()
// for replay-safe eventIds) is covered by the replay-safety scenario.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { createTestRig, makeStubActivities, type TestRig } from "../harness";

const SECRET = "integration-secret"; // matches harness default

function sign(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

async function postEvent(
  baseUrl: string,
  sessionId: string,
  body: object,
): Promise<{ status: number; json: { ok?: boolean; deduped?: boolean } }> {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}/internal/sessions/${sessionId}/progress`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-progress-signature": sign(raw),
      "x-progress-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-progress-event-id": (body as { eventId: string }).eventId,
    },
    body: raw,
  });
  return { status: res.status, json: (await res.json()) as { ok?: boolean; deduped?: boolean } };
}

describe("integration: dedupe", () => {
  let rig: TestRig;

  beforeEach(async () => {
    // We don't need workflow activity stubs since this scenario sends events
    // directly. Pass a no-op stub set anyway because the harness needs them.
    rig = await createTestRig({
      activities: makeStubActivities({ reviewerApprovesAfter: 0 }),
    });
  });

  afterEach(async () => {
    // We didn't call runScenario, so the worker never ran. Teardown still
    // needs to clean up the HTTP server, env vars, and tmp dir.
    await rig.teardown();
  });

  it(
    "drops a repeated eventId — second POST returns deduped:true, no second broadcast",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const event = {
        sessionId,
        turnId: "turn-1",
        eventId: "evt-dup-1",
        seq: 0,
        type: "stage_transition" as const,
        stage: "processing" as const,
        timestamp: Math.floor(Date.now() / 1000),
      };

      const first = await postEvent(rig.receiverUrl, sessionId, event);
      expect(first.status).toBe(200);
      expect(first.json).toEqual({ ok: true });
      expect(rig.sink.captured).toHaveLength(1);

      const second = await postEvent(rig.receiverUrl, sessionId, event);
      expect(second.status).toBe(200);
      expect(second.json).toEqual({ ok: true, deduped: true });
      // Sink should still hold only the original broadcast.
      expect(rig.sink.captured).toHaveLength(1);
    },
  );

  it(
    "treats different eventIds as independent — both broadcast",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const base = {
        sessionId,
        turnId: "turn-1",
        seq: 0,
        type: "stage_transition" as const,
        stage: "processing" as const,
        timestamp: Math.floor(Date.now() / 1000),
      };

      await postEvent(rig.receiverUrl, sessionId, { ...base, eventId: "evt-A", seq: 0 });
      await postEvent(rig.receiverUrl, sessionId, { ...base, eventId: "evt-B", seq: 1 });

      expect(rig.sink.captured).toHaveLength(2);
    },
  );
});
