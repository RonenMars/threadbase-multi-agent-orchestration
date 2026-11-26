// test/engine/run.test.ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runPipeline } from '../../src/engine/run';
import type { PipelineIO } from '../../src/engine/pipeline';

const io: PipelineIO = {
  agent: async () => 'out',
  review: async () => ({ approved: true, notes: '' }),
  gate: async () => {},
  newId: () => 'g',
  wait: async (ready) => ready(),
  emit: async () => {},
};

describe('runPipeline', () => {
  it('rejects a review phase with no agent phase before it', async () => {
    await expect(
      runPipeline({ phases: [{ kind: 'review', role: 'reviewer', maxRework: 1 }] }, io),
    ).rejects.toThrow('review phase "reviewer" has no agent phase before it');
  });

  it('hands the review the latest agent output', async () => {
    const reviewed: string[] = [];
    let n = 0;
    await runPipeline(
      { phases: [{ kind: 'agent', role: 'worker' }, { kind: 'review', role: 'reviewer', maxRework: 1 }] },
      {
        ...io,
        agent: async () => `out ${n++}`,
        review: async (_phase, content) => {
          reviewed.push(content);
          return { approved: reviewed.length > 1, notes: 'redo' };
        },
      },
    );
    expect(reviewed).toEqual(['out 0', 'out 1']);
  });

  it('is not overruled when the pipeline has no review phase', async () => {
    const result = await runPipeline({ phases: [{ kind: 'agent', role: 'worker' }] }, io);
    expect(result).toEqual({ content: 'out', reworkAttempts: 0, overruled: false, stopped: false });
  });
});

describe('src/engine', () => {
  it('names no product: no "threadbase", "streamer" or "stage"', () => {
    const dir = path.resolve(__dirname, '../../src/engine');
    for (const file of readdirSync(dir)) {
      expect(readFileSync(path.join(dir, file), 'utf8'), file).not.toMatch(/threadbase|streamer|stage/i);
    }
  });
});
