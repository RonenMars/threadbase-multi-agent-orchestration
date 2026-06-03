// packages/agent-types/test/stage.test.ts
import { describe, expect, it } from 'vitest';
import { STAGES, type Stage } from '../src/stage';

describe('STAGES', () => {
  it('contains exactly the seven documented stages in pipeline order', () => {
    expect(STAGES).toEqual([
      'thinking',
      'queued',
      'processing',
      'review',
      'rework',
      'sign-off',
      'done',
    ]);
  });

  it('is a readonly tuple (frozen / immutable at runtime)', () => {
    // The `as const` assertion makes STAGES a readonly tuple at the type level.
    // We assert at runtime too: pushing must throw.
    expect(() => {
      // @ts-expect-error — STAGES is readonly; this is the runtime guard for it.
      STAGES.push('not-a-stage');
    }).toThrow();
  });

  it('lets every value type-check as Stage', () => {
    // Compile-time check — assigning each member to `Stage` must compile.
    // If the union is wrong, this won't compile and the test file won't build.
    const samples: Stage[] = [
      'thinking',
      'queued',
      'processing',
      'review',
      'rework',
      'sign-off',
      'done',
    ];
    expect(samples).toHaveLength(7);
  });
});
