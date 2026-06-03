// packages/agent-types/test/session.test.ts
import { describe, expect, it } from 'vitest';
import type { SessionStageAddendum } from '../src/session';
import type { Stage } from '../src/stage';

describe('SessionStageAddendum', () => {
  it('is fully optional (all fields undefined is valid)', () => {
    const a: SessionStageAddendum = {};
    expect(a).toEqual({});
  });

  it('accepts the documented Stage values', () => {
    const stages: Stage[] = [
      'thinking', 'queued', 'processing', 'review', 'rework', 'sign-off', 'done',
    ];
    for (const stage of stages) {
      const a: SessionStageAddendum = { stage };
      expect(a.stage).toBe(stage);
    }
  });

  it('widens to string for additive wire compatibility', () => {
    // A future stage value that does not exist in the current Stage union
    // must still be assignable, because the wire field is widened to string.
    const a: SessionStageAddendum = { stage: 'some-future-stage' };
    expect(a.stage).toBe('some-future-stage');
  });

  it('carries stalledSinceMs for hang detection', () => {
    const a: SessionStageAddendum = { stalledSinceMs: 2500 };
    expect(a.stalledSinceMs).toBe(2500);
  });

  it('carries reworkAttempt when stage is rework', () => {
    const a: SessionStageAddendum = { stage: 'rework', reworkAttempt: 2 };
    expect(a.reworkAttempt).toBe(2);
  });
});
