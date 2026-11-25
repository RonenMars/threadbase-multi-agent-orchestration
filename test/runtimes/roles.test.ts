// test/runtimes/roles.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRole, loadRoles } from '../../src/roles';

function rolesFile(yaml: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roles-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  writeFileSync(path.join(dir, 'roles.yaml'), yaml);
  return path.join(dir, 'roles.yaml');
}

describe('roles', () => {
  it('the shipped roles.yaml runs worker and reviewer as text', () => {
    const roles = loadRoles(path.resolve(__dirname, '../../roles.yaml'));
    expect(roles.worker.runtime).toBe('text');
    expect(roles.reviewer.runtime).toBe('text');
  });

  it('reads fields and loads the prompt file next to roles.yaml', () => {
    const file = rolesFile(
      'coder:\n  runtime: agent-sdk\n  model: m\n  prompt: coder.md\n  tools: [Read, Edit]\n  maxBudgetUsd: 2\n',
      { 'coder.md': 'Be careful.' },
    );
    expect(getRole('coder', file)).toEqual({
      name: 'coder', runtime: 'agent-sdk', model: 'm', prompt: 'Be careful.', tools: ['Read', 'Edit'], maxBudgetUsd: 2,
    });
  });

  it('defaults a missing runtime and an unknown role to text', () => {
    const file = rolesFile('worker:\n  model: m\n');
    expect(getRole('worker', file).runtime).toBe('text');
    expect(getRole('nobody', file)).toEqual({ name: 'nobody', runtime: 'text' });
  });

  it('rejects an unknown runtime', () => {
    expect(() => loadRoles(rolesFile('worker:\n  runtime: gpt\n'))).toThrow(/runtime "gpt"/);
  });
});
