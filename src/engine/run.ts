// src/engine/run.ts
//
// The phase loop. Runs inside workflow code, so it must stay deterministic:
// no clock, no randomness, no I/O except through `io`.

import type { GateAnswer, GateOption, GatePhase, Phase, PipelineIO, PipelineResult, PipelineSpec, Rework, Verdict } from './pipeline';

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
  let stoppedAt: string | undefined;
  let released = false;
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

  /** Opens the gate once and returns the option an answer (or the timeout) picked. */
  async function ask(phase: GatePhase): Promise<GateOption> {
    const options = phase.options!;
    const gateId = io.newId();
    gates.open(gateId, options.length);
    await io.emit({ kind: 'gate_open', phase, gateId });
    const answered = await io.wait(() => gates.answered !== undefined, phase.timeout ?? '24 hours');
    const optionIndex = answered ? gates.answered! : (phase.onTimeout ?? 0);
    gates.close();
    await io.emit({ kind: 'gate_closed', phase, gateId, optionIndex, timedOut: !answered });
    return options[optionIndex];
  }

  function stop(phase: GatePhase) {
    stopped = true;
    stoppedAt = phase.name;
  }

  /** Re-runs the latest agent because a gate asked for it. */
  async function redo(gate: GatePhase, notes: string, escalate?: boolean) {
    if (!agentPhase) throw new Error(`gate "${gate.name}" asked for rework with no agent phase before it`);
    reworkAttempts += 1;
    await runAgent(agentPhase, { attempt: reworkAttempts, notes, ...(escalate ? { escalate } : {}) });
  }

  /** Asks until an answer (or the timeout) picks continue or stop. */
  async function runGate(phase: GatePhase) {
    for (;;) {
      const option = await ask(phase);
      if (option.action === 'stop') return stop(phase);
      if (option.action === 'continue') return;
      // ponytail: no cap on human-requested reworks; each one costs a human answer.
      await redo(phase, option.label);
    }
  }

  /** The gate without its escalating options, when the agent cannot be escalated. */
  async function offered(gate: GatePhase): Promise<GatePhase> {
    if (!gate.options!.some((o) => o.escalate)) return gate;
    if (!io.canEscalate || (await io.canEscalate(agentPhase!.role))) return gate;
    const options = gate.options!.filter((o) => !o.escalate);
    // Dropping an option moves the indexes, so find the timeout's option again.
    return { ...gate, options, onTimeout: options.indexOf(gate.options![gate.onTimeout ?? 0]) };
  }

  /** The review still rejects at the cap: ask until it is accepted, stopped or approved. */
  async function runExhausted(review: Extract<Phase, { kind: 'review' }>, gate: GatePhase) {
    const available = await offered(gate);
    while (!verdict!.approved) {
      const asked = { ...available, detail: verdict!.notes };
      const option = await ask(asked);
      if (option.action === 'stop') return stop(asked);
      if (option.action === 'continue') {
        released = !!option.release;
        return;
      }
      await redo(asked, verdict!.notes, option.escalate);
      await runReview(review);
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
      if (phase.exhausted && !verdict!.approved) await runExhausted(phase, phase.exhausted);
    } else if (!released) {
      await io.emit({ kind: 'started', phase });
      if (phase.options?.length) await runGate(phase);
      else await io.gate(phase);
    }
  }

  const overruled = verdict !== undefined && !verdict.approved;
  await io.emit({ kind: 'finished', content, overruled, stopped, stoppedAt });
  return { content, reworkAttempts, overruled, stopped, stoppedAt };
}
