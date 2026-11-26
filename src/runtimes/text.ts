// src/runtimes/text.ts
//
// One Messages API call: no tools, no repo.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../shared/config';
import type { AgentRuntime } from './index';

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export const textRuntime: AgentRuntime = {
  async run(role, input, ctx) {
    const msg = await claude.messages.create(
      {
        model: role.model ?? config.model,
        max_tokens: input.maxTokens ?? 4096,
        ...(role.prompt ? { system: role.prompt } : {}),
        messages: [{ role: 'user', content: input.prompt }],
      },
      { signal: ctx.signal },
    );
    return {
      content: msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
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
