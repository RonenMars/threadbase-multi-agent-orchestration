// Integration scenario 5 — signal serialization.
//
// Sends two userInput signals back-to-back. The orchestrator's signal handler
// pushes to a queue; the main loop drains one turn at a time. The second
// signal must emit a `queued` stage_transition (since a turn is already in
// flight when it arrives) and only start processing after the first turn
// reaches `done`.
//
// Verifies:
//   - Both turns reach `done`.
//   - turn-2 emits a `queued` stage_transition.
//   - turn-2's `processing` event comes AFTER turn-1's `done` event.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { createTestRig, makeStubActivities, type TestRig } from "../harness";

describe("integration: signal serialization", () => {
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
    "serializes two back-to-back signals — second emits `queued`, processes after first finishes",
    async () => {
      const sessionId = `sess-${nanoid(6)}`;
      const turn1 = `turn-A-${nanoid(4)}`;
      const turn2 = `turn-B-${nanoid(4)}`;

      await rig.runScenario(async () => {
        const handle = await rig.client.workflow.start("orchestratorWorkflow", {
          taskQueue: rig.taskQueue,
          workflowId: `session-${sessionId}`,
          args: [sessionId],
        });

        await handle.signal("userInput", {
          turnId: turn1,
          prompt: "first message",
          conversationHistory: [],
        });
        await handle.signal("userInput", {
          turnId: turn2,
          prompt: "second message",
          conversationHistory: [],
        });

        // Wait for both turns to reach `done`.
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const captured = rig.sink.captured as Array<{
            type?: string;
            turnId?: string;
            stage?: string;
          }>;
          const t1Done = captured.find(
            (m) => m.type === "session_update" && m.stage === "done" && m.turnId === turn1,
          );
          const t2Done = captured.find(
            (m) => m.type === "session_update" && m.stage === "done" && m.turnId === turn2,
          );
          if (t1Done && t2Done) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        await handle.cancel();
      });

      const messages = [...rig.sink.captured] as Array<{
        type: string;
        turnId?: string;
        stage?: string;
      }>;

      // turn-2 must have a `queued` stage_transition somewhere in its event
      // log (emitted by the orchestrator when the signal arrives while turn-1
      // is in flight).
      const turn2Queued = messages.find(
        (m) => m.type === "session_update" && m.turnId === turn2 && m.stage === "queued",
      );
      expect(turn2Queued).toBeDefined();

      // Ordering invariant: turn-2's first `processing` must come AFTER
      // turn-1's `done`. (The orchestrator drains the queue one turn at a
      // time; turn-2 cannot start until turn-1 completes.)
      const turn1DoneIdx = messages.findIndex(
        (m) => m.type === "session_update" && m.turnId === turn1 && m.stage === "done",
      );
      const turn2ProcessingIdx = messages.findIndex(
        (m) => m.type === "session_update" && m.turnId === turn2 && m.stage === "processing",
      );
      expect(turn1DoneIdx).toBeGreaterThanOrEqual(0);
      expect(turn2ProcessingIdx).toBeGreaterThan(turn1DoneIdx);
    },
    40_000,
  );
});
