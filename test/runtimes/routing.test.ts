// test/runtimes/routing.test.ts
//
// The agent activities run each role on its runtime, fall back to text with a
// note when an agent-sdk role has no directory, and make limits non-retryable.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';

let agents: typeof import('../../src/activities/agents');
let runtimes: typeof import('../../src/runtimes').runtimes;
let AgentLimitError: typeof import('../../src/runtimes/agent-sdk').AgentLimitError;

beforeAll(async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roles-'));
  writeFileSync(path.join(dir, 'roles.yaml'), 'worker:\n  runtime: agent-sdk\nreviewer:\n  runtime: agent-sdk\n');
  vi.stubEnv('ROLES_FILE', path.join(dir, 'roles.yaml'));
  agents = await import('../../src/activities/agents');
  ({ runtimes } = await import('../../src/runtimes'));
  ({ AgentLimitError } = await import('../../src/runtimes/agent-sdk'));
});
afterEach(() => vi.restoreAllMocks());

const task = { id: 't1', sessionId: 's1', prompt: 'do it' };
const run = <A extends unknown[], R>(fn: (...a: A) => Promise<R>, ...args: A) => new MockActivityEnvironment().run(fn, ...args);

describe('agent activities', () => {
  it('lists each role runtime', async () => {
    expect(await run(agents.roleRuntimes)).toEqual({ worker: 'agent-sdk', reviewer: 'agent-sdk' });
  });

  it('runs an agent-sdk role in the directory', async () => {
    const sdk = vi.spyOn(runtimes['agent-sdk'], 'run').mockResolvedValue({ content: 'sdk draft', costUsd: 1 });
    const text = vi.spyOn(runtimes.text, 'run');
    const draft = await run(agents.processTask, task, { role: 'worker', cwd: '/repo' });
    expect(draft).toEqual({ taskId: 't1', content: 'sdk draft' });
    expect(sdk.mock.calls[0][0].name).toBe('worker');
    expect(sdk.mock.calls[0][2].cwd).toBe('/repo');
    expect(text).not.toHaveBeenCalled();
  });

  it('runs an agent-sdk role as text, with a note, when there is no directory', async () => {
    vi.spyOn(runtimes.text, 'run').mockResolvedValue({ content: 'text draft', costUsd: 0 });
    const sdk = vi.spyOn(runtimes['agent-sdk'], 'run');
    const draft = await run(agents.processTask, task);
    expect(draft.content).toBe('text draft');
    expect(draft.note).toMatch(/no project directory/);
    expect(sdk).not.toHaveBeenCalled();
  });

  it('reads a structured verdict, and parses text when there is none', async () => {
    vi.spyOn(runtimes['agent-sdk'], 'run').mockResolvedValue({ content: '', costUsd: 0, structured: { approved: true, notes: 'ok' } });
    expect(await run(agents.reviewTask, { taskId: 't1', content: 'x' }, { role: 'reviewer', cwd: '/repo' }))
      .toEqual({ taskId: 't1', approved: true, notes: 'ok' });
    vi.spyOn(runtimes.text, 'run').mockResolvedValue({ content: '```json\n{"approved":false,"notes":"fix"}\n```', costUsd: 0 });
    expect(await run(agents.reviewTask, { taskId: 't1', content: 'x' }))
      .toMatchObject({ approved: false, notes: 'fix' });
  });

  it('makes a session limit non-retryable', async () => {
    vi.spyOn(runtimes['agent-sdk'], 'run').mockRejectedValue(new AgentLimitError('over budget'));
    const err = await run(agents.processTask, task, { role: 'worker', cwd: '/repo' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err.nonRetryable).toBe(true);
  });
});
