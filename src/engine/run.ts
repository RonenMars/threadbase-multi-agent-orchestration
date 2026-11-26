// src/engine/run.ts
//
// The phase loop. Runs inside workflow code, so it must stay deterministic:
// no clock, no randomness, no I/O except through `io`.

import type { GateAnswer, Phase, PipelineIO, PipelineResult, PipelineSpec, Rework, Verdict } from './pipeline';

/**
 * Holds the one open gate. The caller feeds it every answer signal; anything
 * not for the open gate (stale, unknown, out of range, or a second answer)
 * is dropped.
 */
export class GateInbox {
  openGateId: string | undefined;
  private count = 0;
  private chosen: number | undefined;

  open(gateId: string, optionCount: number): void {
    this.openGateId = gateId;
    this.count = optionCount;
    this.chosen = undefined;
  }

  close(): void {
    this.openGateId = undefined;
  }

  get answered(): number | undefined {
    return this.chosen;
  }

  /** True when the answer was accepted. */
  answer({ gateId, optionIndex }: GateAnswer): boolean {
    if (gateId !== this.openGateId || this.chosen !== undefined) return false;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= this.count) return false;
    this.chosen = optionIndex;
    return true;
  }
}

export async function runPipeline(spec: PipelineSpec, io: PipelineIO, gates = new GateInbox()): Promise<PipelineResult> {
  let agentPhase: Extract<Phase, { kind: 'agent' }> | undefined;
  let stopped = false;
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

  /** Asks until an answer (or the timeout) picks continue or stop. */
  async function runGate(phase: Extract<Phase, { kind: 'gate' }>) {
    const options = phase.options!;
    for (;;) {
      const gateId = io.newId();
      gates.open(gateId, options.length);
      await io.emit({ kind: 'gate_open', phase, gateId });
      const answered = await io.wait(() => gates.answered !== undefined, phase.timeout ?? '24 hours');
      const optionIndex = answered ? gates.answered! : (phase.onTimeout ?? 0);
      gates.close();
      await io.emit({ kind: 'gate_closed', phase, gateId, optionIndex, timedOut: !answered });
      const option = options[optionIndex];
      if (option.action === 'stop') {
        stopped = true;
        return;
      }
      if (option.action === 'continue') return;
      if (!agentPhase) throw new Error(`gate "${phase.name}" asked for rework with no agent phase before it`);
      // ponytail: no cap on human-requested reworks; each one costs a human answer.
      reworkAttempts += 1;
      await runAgent(agentPhase, { attempt: reworkAttempts, notes: option.label });
    }
  }

  for (const phase of spec.phases) {
    if (stopped) break;
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
      if (phase.options?.length) await runGate(phase);
      else await io.gate(phase);
    }
  }

  const overruled = verdict !== undefined && !verdict.approved;
  await io.emit({ kind: 'finished', content, overruled, stopped });
  return { content, reworkAttempts, overruled, stopped };
}
