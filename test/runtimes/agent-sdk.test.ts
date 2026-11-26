// test/runtimes/agent-sdk.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const sdk = vi.hoisted(() => ({ messages: [] as unknown[], throwAfter: undefined as Error | undefined, options: undefined as Options | undefined }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Options }) => {
    sdk.options = options;
    return (async function* () {
      for (const m of sdk.messages) yield m;
      if (sdk.throwAfter) throw sdk.throwAfter;
    })();
  },
}));

import { AgentLimitError, agentSdkRuntime, sessionEnv } from '../../src/runtimes/agent-sdk';
import type { Role } from '../../src/roles';

const role: Role = { name: 'coder', runtime: 'agent-sdk', model: 'm' };
const result = (over: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', result: 'done', session_id: 's1', total_cost_usd: 0.25, num_turns: 3, ...over,
});

beforeEach(() => { sdk.messages = [{ type: 'system' }, result()]; sdk.throwAfter = undefined; });

describe('agentSdkRuntime', () => {
  it('needs a project directory', async () => {
    await expect(agentSdkRuntime.run(role, { prompt: 'p' }, {})).rejects.toThrow(/project directory/);
  });

  it('runs read-only, loads no settings, auto-approves only the role tools and returns cost', async () => {
    const seen: string[] = [];
    const out = await agentSdkRuntime.run(
      { ...role, allow: ['Bash(git diff:*)'], mcpServers: { docs: { url: 'http://x/mcp' } }, maxBudgetUsd: 1, prompt: 'extra' },
      { prompt: 'p' },
      { cwd: '/repo', onMessage: (t) => seen.push(t) },
    );
    const o = sdk.options!;
    expect(o.cwd).toBe('/repo');
    expect(o.settingSources).toEqual([]);
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(o.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'mcp__docs']);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.maxBudgetUsd).toBe(1);
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'extra' });
    expect(o.mcpServers).toEqual({ docs: { type: 'http', url: 'http://x/mcp' } });
    expect(o.outputFormat).toBeUndefined();
    expect(out).toMatchObject({ content: 'done', costUsd: 0.25, sessionId: 's1' });
    expect(seen).toEqual(['system', 'result']);
  });

  it('passes a schema as the output format and returns the structured answer', async () => {
    sdk.messages = [result({ structured_output: { approved: true, notes: '' } })];
    const schema = { type: 'object' };
    const out = await agentSdkRuntime.run(role, { prompt: 'p', schema }, { cwd: '/repo' });
    expect(sdk.options!.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(out.structured).toEqual({ approved: true, notes: '' });
  });

  it('fails when a schema was asked for and no structured answer came back', async () => {
    await expect(agentSdkRuntime.run(role, { prompt: 'p', schema: { type: 'object' } }, { cwd: '/repo' }))
      .rejects.toThrow(/no structured answer/);
  });

  it('refuses a .env read and a subagent spawning a subagent through its PreToolUse hook', async () => {
    await agentSdkRuntime.run(role, { prompt: 'p' }, { cwd: '/repo' });
    const hook = sdk.options!.hooks!.PreToolUse![0].hooks[0];
    const signal = new AbortController().signal;
    const call = (tool_name: string, tool_input: unknown, agent_id?: string) =>
      hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u', session_id: 's', transcript_path: '', cwd: '/repo', ...(agent_id ? { agent_id } : {}) } as never, 'u', { signal });
    expect(await call('Read', { file_path: '.env' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await call('Agent', {}, 'a1')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await call('Read', { file_path: 'src/a.ts' })).toEqual({});
  });

  it('filters secret files out of Grep output', async () => {
    await agentSdkRuntime.run(role, { prompt: 'p' }, { cwd: '/repo' });
    const post = sdk.options!.hooks!.PostToolUse![0];
    expect(post.matcher).toBe('Grep');
    const out = await post.hooks[0](
      { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: {}, tool_response: { filenames: ['.env', 'a.ts'], content: '' }, tool_use_id: 'u', session_id: 's', transcript_path: '', cwd: '/repo' } as never,
      'u', { signal: new AbortController().signal });
    expect(out).toMatchObject({ hookSpecificOutput: { updatedToolOutput: { filenames: ['a.ts'] } } });
  });

  it('keeps the result when the SDK throws after it', async () => {
    sdk.throwAfter = new Error('exited with code 1');
    await expect(agentSdkRuntime.run(role, { prompt: 'p' }, { cwd: '/repo' })).resolves.toMatchObject({ content: 'done' });
  });

  it('turns a session limit into AgentLimitError and other errors into a plain Error', async () => {
    sdk.messages = [result({ subtype: 'error_max_budget_usd', errors: ['over'] })];
    await expect(agentSdkRuntime.run(role, { prompt: 'p' }, { cwd: '/repo' })).rejects.toBeInstanceOf(AgentLimitError);
    sdk.messages = [result({ subtype: 'error_during_execution', errors: ['boom'] })];
    const err = await agentSdkRuntime.run(role, { prompt: 'p' }, { cwd: '/repo' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(AgentLimitError);
    expect(err.message).toMatch(/error_during_execution.*boom/);
  });

  it('aborts the session when the caller aborts', async () => {
    const ac = new AbortController();
    await agentSdkRuntime.run(role, { prompt: 'p' }, { cwd: '/repo', signal: ac.signal });
    ac.abort();
    expect(sdk.options!.abortController!.signal.aborted).toBe(true);
  });
});

describe('sessionEnv', () => {
  it('passes only the allowlist, and limits subagents to depth 1', () => {
    const out = sessionEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', THREADBASE_WEBHOOK_SECRET: 's', AWS_SECRET_ACCESS_KEY: 'a', LC_ALL: 'C' });
    expect(out).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', LC_ALL: 'C', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' });
  });
});
