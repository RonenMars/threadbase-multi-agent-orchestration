// test/engine/gate.test.ts
import { describe, expect, it } from 'vitest';

import { GateInbox, runPipeline } from '../../src/engine/run';
import type { Phase, PipelineEvent, PipelineIO } from '../../src/engine/pipeline';

const signOff: Extract<Phase, { kind: 'gate' }> = {
  kind: 'gate',
  name: 'sign-off',
  prompt: 'Release this answer?',
  options: [
    { label: 'Approve', action: 'continue' },
    { label: 'Request changes', action: 'rework' },
    { label: 'Stop', action: 'stop' },
  ],
  timeout: '12 hours',
  onTimeout: 2,
};

const spec = { phases: [{ kind: 'agent', role: 'worker' } as Phase, signOff] };

/**
 * A fake clock-free `wait`: each call takes the next scripted answer (or a
 * timeout) and delivers it through the inbox before checking `ready`, the way
 * a signal lands before Temporal re-evaluates condition().
 */
function harness(script: Array<{ optionIndex: number; stale?: boolean } | 'timeout'>) {
  const inbox = new GateInbox();
  const events: PipelineEvent[] = [];
  const waits: Array<string | number> = [];
  let n = 0;
  const io: PipelineIO = {
    agent: async (_phase, rework) => `out ${n++}${rework ? ` (${rework.notes})` : ''}`,
    review: async () => ({ approved: true, notes: '' }),
    gate: async () => {
      throw new Error('a gate with options must not use the checkpoint');
    },
    newId: () => `g${events.filter((e) => e.kind === 'gate_open').length}`,
    wait: async (ready, timeout) => {
      waits.push(timeout);
      const step = script.shift();
      if (step && step !== 'timeout') {
        const open = inbox.openGateId!;
        if (step.stale) inbox.answer({ gateId: 'not-' + open, optionIndex: step.optionIndex });
        else inbox.answer({ gateId: open, optionIndex: step.optionIndex });
      }
      return ready();
    },
    emit: async (event) => {
      events.push(event);
    },
  };
  return { inbox, events, waits, run: () => runPipeline(spec, io, inbox) };
}

const finished = (events: PipelineEvent[]) => events.filter((e) => e.kind === 'finished');

describe('gate phase', () => {
  it('waits with the phase timeout and continues on Approve', async () => {
    const h = harness([{ optionIndex: 0 }]);
    const result = await h.run();
    expect(h.waits).toEqual(['12 hours']);
    expect(result).toMatchObject({ content: 'out 0', stopped: false });
    expect(h.events.find((e) => e.kind === 'gate_open')).toMatchObject({ gateId: 'g0', phase: signOff });
    expect(h.events.find((e) => e.kind === 'gate_closed')).toMatchObject({ gateId: 'g0', optionIndex: 0, timedOut: false });
    expect(finished(h.events)).toHaveLength(1);
  });

  it('takes onTimeout when nobody answers', async () => {
    const h = harness(['timeout']);
    const result = await h.run();
    expect(result.stopped).toBe(true);
    expect(h.events.find((e) => e.kind === 'gate_closed')).toMatchObject({ optionIndex: 2, timedOut: true });
    expect(finished(h.events)).toEqual([expect.objectContaining({ stopped: true })]);
    // A reply that lands after the timeout closed the gate is dropped.
    expect(h.inbox.answer({ gateId: 'g0', optionIndex: 0 })).toBe(false);
  });

  it('takes onTimeout = continue as an approval', async () => {
    const h = harness(['timeout']);
    signOff.onTimeout = 0;
    try {
      expect((await h.run()).stopped).toBe(false);
    } finally {
      signOff.onTimeout = 2;
    }
  });

  it('drops an answer with a stale gateId, so the gate times out', async () => {
    const h = harness([{ optionIndex: 0, stale: true }]);
    const result = await h.run();
    expect(result.stopped).toBe(true);
    expect(h.events.find((e) => e.kind === 'gate_closed')).toMatchObject({ timedOut: true });
  });

  it('drops an answer when no gate is open, or one out of range', () => {
    const inbox = new GateInbox();
    expect(inbox.answer({ gateId: 'g0', optionIndex: 0 })).toBe(false);
    inbox.open('g0', 3);
    expect(inbox.answer({ gateId: 'g0', optionIndex: 3 })).toBe(false);
    expect(inbox.answer({ gateId: 'g0', optionIndex: -1 })).toBe(false);
    expect(inbox.answer({ gateId: 'g0', optionIndex: 1 })).toBe(true);
    expect(inbox.answer({ gateId: 'g0', optionIndex: 0 })).toBe(false); // first answer wins
    inbox.close();
    expect(inbox.answer({ gateId: 'g0', optionIndex: 0 })).toBe(false);
  });

  it('reworks the last agent on Request changes, then asks again with a new gateId', async () => {
    const h = harness([{ optionIndex: 1 }, { optionIndex: 0 }]);
    const result = await h.run();
    expect(result).toMatchObject({ content: 'out 1 (Request changes)', reworkAttempts: 1, stopped: false });
    expect(h.events.filter((e) => e.kind === 'gate_open').map((e) => (e as { gateId: string }).gateId)).toEqual(['g0', 'g1']);
    expect(h.events).toContainEqual(expect.objectContaining({ kind: 'started', phase: spec.phases[0], attempt: 1 }));
  });

  it('a late answer to the first gate does not close the second', async () => {
    const h = harness([{ optionIndex: 1 }, 'timeout']);
    const inbox = h.inbox;
    const origOpen = inbox.open.bind(inbox);
    inbox.open = (id, count) => {
      origOpen(id, count);
      if (id === 'g1') expect(inbox.answer({ gateId: 'g0', optionIndex: 0 })).toBe(false);
    };
    expect((await h.run()).stopped).toBe(true);
  });

  it('runs no phase after a Stop', async () => {
    const inbox = new GateInbox();
    const ran: string[] = [];
    const io: PipelineIO = {
      agent: async (phase) => {
        ran.push(phase.role);
        return phase.role;
      },
      review: async () => ({ approved: true, notes: '' }),
      gate: async () => {},
      newId: () => 'g0',
      wait: async (ready) => inbox.answer({ gateId: 'g0', optionIndex: 2 }) && ready(),
      emit: async () => {},
    };
    const result = await runPipeline({ phases: [{ kind: 'agent', role: 'worker' }, signOff, { kind: 'agent', role: 'after' }] }, io, inbox);
    expect(ran).toEqual(['worker']);
    expect(result).toMatchObject({ content: 'worker', stopped: true });
  });

  it('always ends the turn with exactly one finished event, last', async () => {
    for (const script of [[{ optionIndex: 0 }], [{ optionIndex: 2 }], ['timeout' as const], [{ optionIndex: 1 }, 'timeout' as const]]) {
      const h = harness([...script]);
      await h.run();
      expect(finished(h.events), JSON.stringify(script)).toHaveLength(1);
      expect(h.events.at(-1)!.kind).toBe('finished');
    }
  });

  it('rejects a rework gate with no agent phase before it', async () => {
    const inbox = new GateInbox();
    const io: PipelineIO = {
      agent: async () => 'x',
      review: async () => ({ approved: true, notes: '' }),
      gate: async () => {},
      newId: () => 'g0',
      wait: async (ready) => inbox.answer({ gateId: 'g0', optionIndex: 1 }) && ready(),
      emit: async () => {},
    };
    await expect(runPipeline({ phases: [signOff] }, io, inbox)).rejects.toThrow(
      'gate "sign-off" asked for rework with no agent phase before it',
    );
  });
});
