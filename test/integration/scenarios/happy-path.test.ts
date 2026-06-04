// Integration scenario 1 — happy path.
//
// Sends one userInput signal to an orchestrator session. The reviewer
// approves on the first review (no rework). Verifies that every expected
// progress event traversed the worker → HMAC → tb-streamer route →
// WSHub.broadcast path, in order, and that the final answer was written
// to JSONL.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { createTestRig, makeStubActivities, type TestRig } from "../harness";

describe("integration: happy path", () => {
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
    "drives one turn end-to-end: stage transitions + agent_output broadcast, JSONL written",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const turnId = `turn-${nanoid(6)}`;

      await rig.runScenario(async () => {
        // Start the long-lived orchestrator workflow.
        const handle = await rig.client.workflow.start("orchestratorWorkflow", {
          taskQueue: rig.taskQueue,
          workflowId: `session-${sessionId}`,
          args: [sessionId],
        });

        // Send a single userInput signal.
        await handle.signal("userInput", {
          turnId,
          prompt: "what is 2 + 2?",
          conversationHistory: [],
        });

        // Wait for the final `done` stage transition to traverse all the way
        // to the WS sink. Polling is acceptable here because the rig is
        // entirely in-process; production code would react to the WSMessage
        // arrival instead.
        const deadline = Date.now() + 15_000;
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

        // Once we've seen `done`, cancel the orchestrator so runUntil returns.
        await handle.cancel();
      });

      // ─── Assertions on the broadcast log ─────────────────────────────────
      const messages = [...rig.sink.captured] as Array<{
        type: string;
        sessionId?: string;
        turnId?: string;
        stage?: string;
        role?: string;
        content?: string;
        reason?: string;
      }>;

      // Every message belongs to our session.
      expect(messages.every((m) => m.sessionId === sessionId)).toBe(true);

      // Expected stage sequence on the happy path (per spec §3.2):
      //   processing → review → sign-off → done
      const stageTransitions = messages
        .filter((m) => m.type === "session_update")
        .map((m) => m.stage);
      expect(stageTransitions).toEqual(["processing", "review", "sign-off", "done"]);

      // Each agent emits one agent_output block (worker draft, reviewer
      // verdict, final answer at done).
      const agentOutputs = messages.filter((m) => m.type === "agent_output");
      expect(agentOutputs.length).toBe(3);

      // Roles map from stage: processing→worker, review→reviewer, done→worker.
      // The route's stageToRole helper handles this; we assert the mapping
      // arrives correctly.
      const roleByStage = agentOutputs.map((m) => ({ stage: m.stage, role: m.role }));
      expect(roleByStage).toEqual([
        { stage: "processing", role: "worker" },
        { stage: "review", role: "reviewer" },
        { stage: "done", role: "worker" },
      ]);

      // No turn_failure emitted on the happy path.
      expect(messages.find((m) => m.type === "turn_failure")).toBeUndefined();

      // ─── JSONL was written for the final answer ──────────────────────────
      const jsonlPath = join(rig.conversationsDir, `${sessionId}.jsonl`);
      const text = await readFile(jsonlPath, "utf8");
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]) as {
        role: string;
        turnId: string;
        content: string;
        reviewerOverruled?: boolean;
      };
      expect(record.role).toBe("assistant");
      expect(record.turnId).toBe(turnId);
      expect(record.content).toContain("draft #1");
      // Reviewer approved on first call — no overrule.
      expect(record.reviewerOverruled).toBeUndefined();
    },
    30_000,
  );
});
