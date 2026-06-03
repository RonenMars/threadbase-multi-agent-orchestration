// Integration scenario 3 — rework cap + reviewerOverruled.
//
// Stub the reviewer to NEVER approve. The turn workflow loops worker→review
// twice (the cap), then signs off with the last draft anyway, emitting a
// final agent_output flagged `reviewerOverruled: true`. Verifies:
//   - Stage sequence includes 2 rework iterations + sign-off + done.
//   - reworkAttempt field is 1 and 2 on the two rework stage_transitions.
//   - Final agent_output payload carries reviewerOverruled: true.
//   - JSONL line carries reviewerOverruled: true.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { createTestRig, makeStubActivities, type TestRig } from "../harness";

describe("integration: rework cap + reviewerOverruled", () => {
  let rig: TestRig;

  beforeEach(async () => {
    // Reviewer needs at least 3 approvals to approve; cap is 2 reworks → 3
    // review calls total. So 3 = never approves before cap.
    rig = await createTestRig({
      activities: makeStubActivities({ reviewerApprovesAfter: 3 }),
    });
  });

  afterEach(async () => {
    await rig.teardown();
  });

  it(
    "hits the rework cap, emits reviewerOverruled on final answer, writes the flag to JSONL",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const turnId = `turn-${nanoid(6)}`;

      await rig.runScenario(async () => {
        const handle = await rig.client.workflow.start("orchestratorWorkflow", {
          taskQueue: rig.taskQueue,
          workflowId: `session-${sessionId}`,
          args: [sessionId],
        });

        await handle.signal("userInput", {
          turnId,
          prompt: "pick a number",
          conversationHistory: [],
        });

        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const done = rig.sink.captured.find(
            (m) =>
              (m as { type?: string }).type === "session_update" &&
              (m as { stage?: string }).stage === "done" &&
              (m as { sessionId?: string }).sessionId === sessionId,
          );
          if (done) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        await handle.cancel();
      });

      const messages = [...rig.sink.captured] as Array<{
        type: string;
        sessionId?: string;
        turnId?: string;
        stage?: string;
        role?: string;
        content?: string;
        reworkAttempt?: number;
        reviewerOverruled?: boolean;
      }>;

      // Stage sequence:
      //   processing → review → rework → review → rework → review → sign-off → done
      const stages = messages
        .filter((m) => m.type === "session_update")
        .map((m) => m.stage);
      expect(stages).toEqual([
        "processing",
        "review",
        "rework",
        "review",
        "rework",
        "review",
        "sign-off",
        "done",
      ]);

      // The two rework stage_transitions carry reworkAttempt 1 and 2.
      const reworkTransitions = messages.filter(
        (m) => m.type === "session_update" && m.stage === "rework",
      );
      expect(reworkTransitions.map((m) => m.reworkAttempt)).toEqual([1, 2]);

      // The final agent_output (stage === 'done') has reviewerOverruled: true.
      const finalOutput = messages.find(
        (m) => m.type === "agent_output" && m.stage === "done",
      );
      expect(finalOutput).toBeDefined();
      expect(finalOutput!.reviewerOverruled).toBe(true);

      // JSONL line carries the flag too.
      const jsonlPath = join(rig.conversationsDir, `${sessionId}.jsonl`);
      const text = await readFile(jsonlPath, "utf8");
      const record = JSON.parse(text.trim());
      expect(record.reviewerOverruled).toBe(true);
    },
    40_000,
  );
});
