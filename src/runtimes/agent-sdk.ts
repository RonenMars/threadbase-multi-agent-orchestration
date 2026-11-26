// src/runtimes/agent-sdk.ts
//
// A Claude Agent SDK session in the user's repo. The role decides the tools;
// nothing is loaded from settings files on disk, so a repo the agent can
// write cannot hand the next session hooks, MCP servers or instructions.

import { query, type HookCallback, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../shared/config';
import type { AgentRuntime } from './index';
import { guardToolUse, mask, redactGrep } from './secrets';

/** A session that stopped on one of its own limits. Retrying it would hit the same limit. */
export class AgentLimitError extends Error {}

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/** The worker's own secrets (webhook key, Temporal address) stay out of the session. */
const PASSED_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|TERM|LC_.*|ANTHROPIC_.*|CLAUDE_CODE_.*)$/;

export function sessionEnv(env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && PASSED_ENV.test(k)) out[k] = v;
  out.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '1';
  return out;
}

function secretGuard(cwd: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const reason = guardToolUse(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, cwd, !!input.agent_id);
    if (!reason) return {};
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    };
  };
}

function grepRedactor(cwd: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    const updatedToolOutput = redactGrep(input.tool_response, cwd);
    return updatedToolOutput ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } } : {};
  };
}

const LIMITS = new Set(['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']);

export const agentSdkRuntime: AgentRuntime = {
  async run(role, input, ctx) {
    if (!ctx.cwd) throw new Error(`${role.name}: the agent-sdk runtime needs a project directory`);
    const abortController = new AbortController();
    if (ctx.signal?.aborted) abortController.abort();
    ctx.signal?.addEventListener('abort', () => abortController.abort(), { once: true });

    const tools = role.tools ?? READ_ONLY_TOOLS;
    const mcpServers = role.mcpServers ?? {};
    const options: Options = {
      cwd: ctx.cwd,
      model: role.model ?? config.model,
      tools,
      allowedTools: [...tools, ...(role.allow ?? []), ...Object.keys(mcpServers).map((s) => `mcp__${s}`)],
      permissionMode: role.permissionMode ?? 'dontAsk',
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(role.prompt ? { append: role.prompt } : {}) },
      mcpServers: Object.fromEntries(Object.entries(mcpServers).map(([k, s]) => [k, { type: 'http' as const, ...s }])),
      maxTurns: role.maxTurns ?? 50,
      ...(role.maxBudgetUsd !== undefined ? { maxBudgetUsd: role.maxBudgetUsd } : {}),
      ...(role.effort ? { effort: role.effort } : {}),
      ...(input.schema ? { outputFormat: { type: 'json_schema', schema: input.schema } } : {}),
      ...(ctx.resume ? { resume: ctx.resume } : {}),
      abortController,
      env: sessionEnv(),
      hooks: {
        PreToolUse: [{ hooks: [secretGuard(ctx.cwd)] }],
        PostToolUse: [{ matcher: 'Grep', hooks: [grepRedactor(ctx.cwd)] }],
      },
      stderr: (data) => ctx.log?.(mask(data)),
    };

    let result: SDKResultMessage | undefined;
    try {
      for await (const message of query({ prompt: input.prompt, options })) {
        ctx.onMessage?.(message.type);
        if (message.type === 'result') result = message;
      }
    } catch (err) {
      // After an error result the CLI exits non-zero and the SDK throws; the result says more.
      if (!result || abortController.signal.aborted) throw err;
    }
    if (!result) throw new Error(`${role.name}: the session ended without a result`);

    const stats = {
      turns: result.num_turns,
      costUsd: result.total_cost_usd,
      sessionId: result.session_id,
      denied: result.permission_denials?.map((d) => d.tool_name),
    };
    if (result.subtype !== 'success') {
      const reason = mask(`${role.name}: ${result.subtype} after ${result.num_turns} turns ($${result.total_cost_usd.toFixed(4)})` +
        (result.errors?.length ? `: ${result.errors.join('; ')}` : ''));
      throw LIMITS.has(result.subtype) ? new AgentLimitError(reason) : new Error(reason);
    }
    if (input.schema && result.structured_output === undefined) {
      throw new Error(`${role.name}: no structured answer; the session said: ${mask(result.result).slice(0, 500)}`);
    }
    return {
      content: result.result,
      costUsd: result.total_cost_usd,
      sessionId: result.session_id,
      structured: result.structured_output,
      stats,
    };
  },
};
