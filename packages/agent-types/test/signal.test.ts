// packages/agent-types/test/signal.test.ts
import { describe, expect, it } from 'vitest';
import type { ConversationTurn, UserInputSignal } from '../src/signal';

describe('ConversationTurn', () => {
  it('accepts a user turn', () => {
    const t: ConversationTurn = { role: 'user', content: 'hello' };
    expect(t.role).toBe('user');
  });

  it('accepts an assistant turn', () => {
    const t: ConversationTurn = { role: 'assistant', content: 'hi there' };
    expect(t.role).toBe('assistant');
  });
});

describe('UserInputSignal', () => {
  it('carries a turn id, prompt, and full conversation history snapshot', () => {
    const sig: UserInputSignal = {
      turnId: 'turn_001',
      prompt: 'What is the capital of France?',
      conversationHistory: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    expect(sig.turnId).toBe('turn_001');
    expect(sig.conversationHistory).toHaveLength(2);
  });

  it('accepts an empty history (first turn in a session)', () => {
    const sig: UserInputSignal = {
      turnId: 'turn_000',
      prompt: 'first message',
      conversationHistory: [],
    };
    expect(sig.conversationHistory).toEqual([]);
  });
});
