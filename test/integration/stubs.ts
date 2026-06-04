// Activity stub factories for integration scenarios.
//
// The integration tests want REAL `sendProgressEvent` (HMAC over real HTTP)
// but STUBBED `processTask` / `reviewTask` / `productSignOff` — the LLM-y
// activities. This module produces a `stubs` object compatible with the
// shape Temporal expects in `Worker.create({ activities: ... })`.
//
// Each factory takes a config object so scenarios can describe behavior
// declaratively (e.g. "reviewer approves after 1 rework") instead of
// hand-rolling a fake per test.

import type { Draft, Review, Task } from "../../src/shared/types";

export interface StubBehavior {
  /**
   * 0 = reviewer approves on the FIRST review call (happy path, no rework).
   * 1 = reviewer approves on the second review call (1 rework).
   * 2 = reviewer approves on the third review call (2 reworks, the cap).
   * 3 or more = reviewer never approves before the cap is hit
   *             (drives `reviewerOverruled: true` on the final answer).
   */
  reviewerApprovesAfter: number;

  /**
   * If set, `reviewTask` will throw on the call whose index matches.
   * Used to test transient activity failure handling.
   * 0 = throw on the first review; 1 = throw on the second review; etc.
   * Undefined means "never throw".
   */
  reviewerThrowsOnCall?: number;

  /**
   * If true, `reviewTask` throws on EVERY call — including activity retries.
   * Used to test ChildWorkflowFailure propagation (spec §7.5): the activity
   * exhausts its retry budget, the child workflow fails, and the orchestrator
   * catches + emits `terminal_failure`.
   */
  reviewerAlwaysThrows?: boolean;

  /**
   * Whether `processTask` should set the draft content to the reviewer's
   * notes from the previous review (mimicking "address the feedback").
   * Default true. Set false to keep all drafts identical, e.g. to assert
   * that the final answer matches the first draft when reviewer never
   * approves.
   */
  echoReviewerNotes?: boolean;
}

export interface ActivityStubs {
  processTask: (task: Task) => Promise<Draft>;
  reviewTask: (draft: Draft) => Promise<Review>;
  productSignOff: (draft: Draft, review: Review) => Promise<boolean>;
}

/**
 * Construct a fresh stub set per test. Each instance closes over its own
 * call counters so scenarios run independently.
 */
export function makeStubActivities(behavior: StubBehavior): ActivityStubs {
  const echoNotes = behavior.echoReviewerNotes ?? true;
  let processCalls = 0;
  let reviewCalls = 0;
  let lastReviewerNotes = "";

  return {
    async processTask(task: Task): Promise<Draft> {
      processCalls += 1;
      const baseContent = `draft #${processCalls} for ${task.id}`;
      const content =
        echoNotes && lastReviewerNotes
          ? `${baseContent} (addressing: ${lastReviewerNotes})`
          : baseContent;
      return { taskId: task.id, content };
    },

    async reviewTask(draft: Draft): Promise<Review> {
      const callIndex = reviewCalls;
      reviewCalls += 1;

      if (behavior.reviewerAlwaysThrows) {
        throw new Error(`stub reviewer always-throws (call ${callIndex})`);
      }
      if (behavior.reviewerThrowsOnCall === callIndex) {
        throw new Error(`stub reviewer error on call ${callIndex}`);
      }

      const approved = callIndex >= behavior.reviewerApprovesAfter;
      const notes = approved ? "" : `revise pass ${callIndex + 1}`;
      lastReviewerNotes = notes;
      return { taskId: draft.taskId, approved, notes };
    },

    async productSignOff(_draft: Draft, review: Review): Promise<boolean> {
      // Real sign-off returns `review.approved`. We mirror that so the
      // workflow's `await productSignOff(...)` resolves identically to
      // production behavior; the result isn't load-bearing for the
      // workflow's emitted events.
      return review.approved;
    },
  };
}
