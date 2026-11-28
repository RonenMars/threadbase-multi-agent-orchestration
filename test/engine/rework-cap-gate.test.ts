// test/engine/rework-cap-gate.test.ts
//
// When a review still rejects at the rework cap, a review phase with an
// `exhausted` gate asks a human instead of silently overruling the reviewer.
import { describe, expect, it } from 'vitest';

import { GateInbox, runPipeline } from '../../src/engine/run';
import type { Phase, PipelineEvent, PipelineIO, Rework } from '../../src/engine/pipeline';

const exhausted: Extract<Phase, { kind: 'gate' }> = {
  kind: 'gate',
  name: 'cap',
  options: [
    { label: 'Accept anyway', action: 'continue', release: true },
    { label: 'Retry stronger', action: 'rework', escalate: true },
    { label: 'Stop', action: 'stop' },
  ],
  timeout: '12 hours',
  onTimeout: 2,
};

const signOff: Phase = {
  kind: 'gate',
  name: 'sign-off',
  options: [{ label: 'Approve', action: 'continue' }],
};

const spec = {
  phases: [
    { kind: 'agent', role: 'worker' } as Phase,
    { kind: 'review', role: 'reviewer', maxRework: 1, exhausted } as Phase,
    signOff,
  ],
};

/** `answers` is taken one per gate wait; `approvesAt` is the first review call (0-based) that approves. */
async function run(
  answers: Array<number | 'timeout'>,
  { approvesAt = Infinity, canEscalate }: { approvesAt?: number; canEscalate?: boolean } = {},
) {
  const inbox = new GateInbox();
  const events: PipelineEvent[] = [];
  const reworks: Array<Rework | undefined> = [];
  let reviews = 0;
  const io: PipelineIO = {
    agent: async (_phase, rework) => {
      reworks.push(rework);
      return `out ${reworks.length - 1}`;
    },
    review: async () => {
      const n = reviews++;
      return { approved: n >= approvesAt, notes: `notes ${n}` };
    },
    gate: async () => {},
    newId: () => `g${events.filter((e) => e.kind === 'gate_open').length}`,
    wait: async (ready) => {
      const step = answers.shift();
      if (step === undefined) throw new Error('an unscripted gate opened');
      if (step !== 'timeout') inbox.answer({ gateId: inbox.openGateId!, optionIndex: step });
      return ready();
    },
    emit: async (event) => {
      events.push(event);
    },
    ...(canEscalate === undefined ? {} : { canEscalate: async () => canEscalate }),
  };
  const result = await runPipeline(spec, io, inbox);
  const opened = events.flatMap((e) => (e.kind === 'gate_open' ? [e.phase] : []));
  return { result, events, reworks, opened };
}

describe('rework-cap gate', () => {
  it('does not open when the review approves within the cap', async () => {
    const { opened, result } = await run([0], { approvesAt: 1 });
    expect(opened.map((g) => g.name)).toEqual(['sign-off']);
    expect(result.overruled).toBe(false);
  });

  it('Accept anyway releases the draft as overruled and skips later gates', async () => {
    const { opened, result, events } = await run([0]);
    expect(opened.map((g) => g.name)).toEqual(['cap']);
    expect(result).toMatchObject({ content: 'out 1', reworkAttempts: 1, overruled: true, stopped: false });
    expect(events.filter((e) => e.kind === 'started' && e.phase.kind === 'gate')).toEqual([]);
    expect(events.at(-1)!.kind).toBe('finished');
  });

  it('Stop ends the run and says which gate stopped it', async () => {
    const { opened, result, events } = await run([2]);
    expect(opened.map((g) => g.name)).toEqual(['cap']);
    expect(result).toMatchObject({ stopped: true, stoppedAt: 'cap' });
    expect(events.at(-1)).toMatchObject({ kind: 'finished', stopped: true, stoppedAt: 'cap' });
  });

  it('stops when nobody answers', async () => {
    const { result, events } = await run(['timeout']);
    expect(result).toMatchObject({ stopped: true, stoppedAt: 'cap' });
    expect(events.find((e) => e.kind === 'gate_closed')).toMatchObject({ optionIndex: 2, timedOut: true });
  });

  it('Retry re-runs the agent escalated with the reviewer notes; approval goes on to sign-off', async () => {
    const { opened, result, reworks } = await run([1, 0], { approvesAt: 2 });
    expect(reworks[2]).toEqual({ attempt: 2, notes: 'notes 1', escalate: true });
    expect(opened.map((g) => g.name)).toEqual(['cap', 'sign-off']);
    expect(result).toMatchObject({ content: 'out 2', reworkAttempts: 2, overruled: false, stopped: false });
  });

  it('asks again under a new id when the retry is rejected too', async () => {
    const { opened, events, result, reworks } = await run([1, 1, 2]);
    expect(opened.map((g) => g.name)).toEqual(['cap', 'cap', 'cap']);
    expect(events.flatMap((e) => (e.kind === 'gate_open' ? [e.gateId] : []))).toEqual(['g0', 'g1', 'g2']);
    expect(reworks[3]).toEqual({ attempt: 3, notes: 'notes 2', escalate: true });
    expect(result.stopped).toBe(true);
  });

  it('hides the escalating option when escalation is unavailable, and keeps the timeout on Stop', async () => {
    const { opened, events, result } = await run(['timeout'], { canEscalate: false });
    expect(opened[0].options!.map((o) => o.label)).toEqual(['Accept anyway', 'Stop']);
    expect(events.find((e) => e.kind === 'gate_closed')).toMatchObject({ optionIndex: 1, timedOut: true });
    expect(result.stopped).toBe(true);
  });

  it('keeps all options when escalation is available', async () => {
    const { opened } = await run([2], { canEscalate: true });
    expect(opened[0].options).toHaveLength(3);
  });
});
