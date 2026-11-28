// src/runtimes/text.ts
//
// One Messages API call: no tools, no repo.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../shared/config';
import type { AgentRuntime } from './index';

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from env

/** Thinking counts toward max_tokens, so a call with an effort level needs far more room. */
const EFFORT_MAX_TOKENS = 64_000;

export const textRuntime: AgentRuntime = {
  async run(role, input, ctx) {
    const params = {
      model: role.model ?? config.model,
      max_tokens: role.effort ? EFFORT_MAX_TOKENS : (input.maxTokens ?? 4096),
      ...(role.effort ? { output_config: { effort: role.effort } } : {}),
      ...(role.prompt ? { system: role.prompt } : {}),
      messages: [{ role: 'user' as const, content: input.prompt }],
    };
    // A limit this large has to stream, or the SDK refuses the request.
    const msg = role.effort
      ? await claude.messages.stream(params, { signal: ctx.signal }).finalMessage()
      : await claude.messages.create(params, { signal: ctx.signal });
    const content = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    if (role.effort && (!content || msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens')) {
      throw new Error(`${role.name}: no complete answer (stop reason ${msg.stop_reason})`);
    }
    return {
      content,
      // ponytail: text cost is not priced yet; the M5 spend cap adds per-model pricing.
      costUsd: 0,
      stats: {
        inputTokens: msg.usage?.input_tokens,
        outputTokens: msg.usage?.output_tokens,
        stopReason: msg.stop_reason,
      },
    };
  },
};
