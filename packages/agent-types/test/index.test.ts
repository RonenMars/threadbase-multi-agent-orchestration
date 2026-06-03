// packages/agent-types/test/index.test.ts
import { describe, expect, it } from 'vitest';
import * as api from '../src/index';

describe('public surface', () => {
  it('re-exports STAGES at runtime', () => {
    expect(api.STAGES).toBeDefined();
    expect(api.STAGES).toContain('processing');
  });

  it('exports the expected runtime value keys (and nothing else)', () => {
    // Types are erased at runtime; STAGES is the only runtime export.
    // This guards against accidentally exporting a runtime helper that
    // wasn't part of the spec.
    expect(Object.keys(api).sort()).toEqual(['STAGES']);
  });
});

// Compile-time check that every documented type is re-exported.
// If any name is missing or renamed, this file won't typecheck.
import type {
  Stage,
  ProgressEvent,
  ProgressEventType,
  AgentOutputPayload,
  ConversationTurn,
  UserInputSignal,
  SessionStageAddendum,
} from '../src/index';

describe('type re-exports', () => {
  it('is reachable through the package entry point', () => {
    // We only need to USE the types for the compile check to bite. The runtime
    // assertion below is incidental.
    const stage: Stage = 'processing';
    const eventType: ProgressEventType = 'agent_output';
    const ev: ProgressEvent = {
      sessionId: 's', turnId: 't', eventId: 'e', seq: 0,
      type: 'stage_transition', timestamp: 0,
    };
    const out: AgentOutputPayload = { content: 'x' };
    const turn: ConversationTurn = { role: 'user', content: 'x' };
    const sig: UserInputSignal = { turnId: 't', prompt: 'p', conversationHistory: [] };
    const add: SessionStageAddendum = {};

    expect({ stage, eventType, ev, out, turn, sig, add }).toBeDefined();
  });
});
