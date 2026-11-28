// test/runtimes/escalation.test.ts
//
// An escalated call runs the role on its escalation model and effort.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { loadRoles } from '../../src/roles';

const { create, stream } = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create, stream };
  },
}));

let agents: typeof import('../../src/activities/agents');
let rolesPath: string;
const write = (yaml: string) => writeFileSync(rolesPath, yaml);

beforeAll(async () => {
  rolesPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'roles-')), 'roles.yaml');
  write('worker:\n  model: base\n');
  vi.stubEnv('ROLES_FILE', rolesPath);
  agents = await import('../../src/activities/agents');
});
afterEach(() => {
  create.mockReset();
  stream.mockReset();
});

const task = { id: 't1', sessionId: 's1', prompt: 'do it' };
const run = <A extends unknown[], R>(fn: (...a: A) => Promise<R>, ...args: A) => new MockActivityEnvironment().run(fn, ...args);
const message = (text: string, stop_reason = 'end_turn') => ({
  content: text ? [{ type: 'text', text }] : [],
  stop_reason,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const escalating = 'worker:\n  model: base\n  escalationModel: strong\n  escalationEffort: xhigh\n';

describe('escalation', () => {
  it('the shipped worker escalates to Opus 5.5 at xhigh', () => {
    const { worker } = loadRoles(path.resolve(__dirname, '../../roles.yaml'));
    expect(worker.escalationModel).toBe('claude-opus-5-5');
    expect(worker.escalationEffort).toBe('xhigh');
  });

  it('is available only for a role with an escalation model', async () => {
    write(escalating);
    expect(await run(agents.escalationAvailable, 'worker')).toBe(true);
    write('worker:\n  model: base\n');
    expect(await run(agents.escalationAvailable, 'worker')).toBe(false);
  });

  it('streams an escalated text call on the escalation model with its effort and room to think', async () => {
    write(escalating);
    stream.mockReturnValue({ finalMessage: async () => message('better') });
    const draft = await run(agents.processTask, task, { role: 'worker', escalate: true });
    expect(draft.content).toBe('better');
    expect(stream.mock.calls[0][0]).toMatchObject({ model: 'strong', output_config: { effort: 'xhigh' }, max_tokens: 64000 });
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves a normal call as it was', async () => {
    write(escalating);
    create.mockResolvedValue(message('plain'));
    await run(agents.processTask, task, { role: 'worker' });
    expect(create.mock.calls[0][0]).toEqual({ model: 'base', max_tokens: 4096, messages: [{ role: 'user', content: 'do it' }] });
    expect(stream).not.toHaveBeenCalled();
  });

  for (const [text, reason] of [['', 'end_turn'], ['partial', 'refusal'], ['partial', 'max_tokens']]) {
    it(`fails an effort call that ends ${reason} with ${text ? 'partial' : 'no'} text`, async () => {
      write(escalating);
      stream.mockReturnValue({ finalMessage: async () => message(text, reason) });
      await expect(run(agents.processTask, task, { role: 'worker', escalate: true })).rejects.toThrow(reason);
    });
  }

  it('escalates an agent-sdk role the same way', async () => {
    write('worker:\n  runtime: agent-sdk\n  effort: low\n  escalationModel: strong\n  escalationEffort: xhigh\n');
    const { runtimes } = await import('../../src/runtimes');
    const sdk = vi.spyOn(runtimes['agent-sdk'], 'run').mockResolvedValue({ content: 'x', costUsd: 0 });
    await run(agents.processTask, task, { role: 'worker', cwd: '/repo', escalate: true });
    expect(sdk.mock.calls[0][0]).toMatchObject({ model: 'strong', effort: 'xhigh' });
  });
});
