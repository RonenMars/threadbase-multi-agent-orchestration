// src/threadbase/stages.ts
//
// Maps engine events onto the agent-types wire events the streamer reads.
// Pure and deterministic: it runs inside workflow code.

import type { AgentOutputPayload, ProgressEvent, Stage } from '@threadbase-sh/agent-types';
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
        output('done', { content: event.content, reviewerOverruled: event.overruled || undefined }),
      ];
    case 'gate_open':
    case 'gate_closed':
      return []; // wire events land with the agent-types gate_open / gate_closed release
  }
}
