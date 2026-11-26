// src/threadbase/stages.ts
//
// Maps engine events onto the agent-types wire events the streamer reads.
// Pure and deterministic: it runs inside workflow code.

import type {
  AgentOutputPayload,
  GateClosedPayload,
  GateOpenPayload,
  ProgressEvent,
  Stage,
} from '@threadbase-sh/agent-types';
import type { Phase, PipelineEvent } from '../engine/pipeline';

/** A progress event before the workflow stamps its identity, seq and time. */
export type ProgressPartial = Omit<ProgressEvent, 'sessionId' | 'turnId' | 'eventId' | 'seq' | 'timestamp'>;

function stageOf(phase: Phase, attempt?: number): Stage {
  if (phase.kind === 'agent') return attempt ? 'rework' : 'processing';
  if (phase.kind === 'review') return 'review';
  return 'sign-off';
}

function output(stage: Stage, payload: AgentOutputPayload, attempt?: number): ProgressPartial {
  return {
    type: 'agent_output',
    stage,
    ...(attempt ? { reworkAttempt: attempt } : {}),
    payload: payload as unknown as Record<string, unknown>,
  };
}

/** What a turn delivers when the human stops it at a gate. */
export const STOPPED_CONTENT = 'Stopped at sign-off. The answer was not released.';

export function toProgress(event: PipelineEvent): ProgressPartial[] {
  switch (event.kind) {
    case 'started': {
      const stage = stageOf(event.phase, event.attempt);
      return [{ type: 'stage_transition', stage, ...(event.attempt ? { reworkAttempt: event.attempt } : {}) }];
    }
    case 'output': {
      const content = event.phase.kind === 'review'
        ? event.content || (event.approved ? 'approved' : '')
        : event.content;
      return [output(stageOf(event.phase, event.attempt), { content }, event.attempt)];
    }
    case 'finished':
      return [
        { type: 'stage_transition', stage: 'done' },
        output('done', {
          content: event.stopped ? STOPPED_CONTENT : event.content,
          reviewerOverruled: event.overruled || undefined,
        }),
      ];
    case 'gate_open': {
      const gate = event.phase as Extract<Phase, { kind: 'gate' }>;
      const payload: GateOpenPayload = {
        gateId: event.gateId,
        prompt: gate.prompt ?? gate.name,
        ...(gate.detail ? { detail: gate.detail } : {}),
        options: (gate.options ?? []).map((o) => o.label),
      };
      return [{ type: 'gate_open', stage: 'sign-off', payload: payload as unknown as Record<string, unknown> }];
    }
    case 'gate_closed': {
      const payload: GateClosedPayload = {
        gateId: event.gateId,
        optionIndex: event.optionIndex,
        timedOut: event.timedOut,
      };
      return [{ type: 'gate_closed', stage: 'sign-off', payload: payload as unknown as Record<string, unknown> }];
    }
  }
}
