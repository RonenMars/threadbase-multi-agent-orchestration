// src/engine/run.ts
//
// The phase loop. Runs inside workflow code, so it must stay deterministic:
// no clock, no randomness, no I/O except through `io`.

import type { Phase, PipelineIO, PipelineResult, PipelineSpec, Rework, Verdict } from './pipeline';

export async function runPipeline(spec: PipelineSpec, io: PipelineIO): Promise<PipelineResult> {
  let agentPhase: Extract<Phase, { kind: 'agent' }> | undefined;
  let content = '';
  let verdict: Verdict | undefined;
  let reworkAttempts = 0;

  async function runAgent(phase: Extract<Phase, { kind: 'agent' }>, rework?: Rework) {
    const attempt = rework?.attempt;
    await io.emit({ kind: 'started', phase, attempt });
    content = await io.agent(phase, rework);
    await io.emit({ kind: 'output', phase, attempt, content });
  }

  async function runReview(phase: Extract<Phase, { kind: 'review' }>) {
    await io.emit({ kind: 'started', phase });
    verdict = await io.review(phase, content);
    await io.emit({ kind: 'output', phase, content: verdict.notes, approved: verdict.approved });
  }

  for (const phase of spec.phases) {
    if (phase.kind === 'agent') {
      agentPhase = phase;
      await runAgent(phase);
    } else if (phase.kind === 'review') {
      if (!agentPhase) throw new Error(`review phase "${phase.role}" has no agent phase before it`);
      await runReview(phase);
      for (let attempt = 1; !verdict!.approved && attempt <= phase.maxRework; attempt += 1) {
        reworkAttempts += 1;
        await runAgent(agentPhase, { attempt, notes: verdict!.notes });
        await runReview(phase);
      }
    } else {
      await io.emit({ kind: 'started', phase });
      await io.gate(phase);
    }
  }

  const overruled = verdict !== undefined && !verdict.approved;
  await io.emit({ kind: 'finished', content, overruled });
  return { content, reworkAttempts, overruled };
}
