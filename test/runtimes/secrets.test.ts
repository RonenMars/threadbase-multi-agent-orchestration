// test/runtimes/secrets.test.ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardToolUse, isSecretPath, mask, redactGrep } from '../../src/runtimes/secrets';

const home = mkdtempSync(path.join(os.tmpdir(), 'home-'));
const repo = path.join(home, 'repo');
mkdirSync(repo);
mkdirSync(path.join(home, '.ssh'));
writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'k');
writeFileSync(path.join(repo, '.env'), 'X=1');
symlinkSync(path.join(home, '.ssh'), path.join(repo, 'keys'));
const env = {};
const guard = (tool: string, input: Record<string, unknown>, sub = false) => guardToolUse(tool, input, repo, sub, home, env);

describe('guardToolUse', () => {
  it.each([
    ['.env'], ['.env.local'], ['sub/.env.production'], ['~/.ssh/config'], ['keys/config'], [`${home}/.aws/credentials`],
    ['server.pem'], ['tls.key'], ['credentials.json'], ['~/.threadbase/config.json'], ['~/.config/gh/hosts.yml'],
  ])('refuses a read of %s', (file) => {
    expect(guard('Read', { file_path: file })).toBeDefined();
  });

  it.each([['.env.example'], ['src/index.ts'], ['README.md'], ['envelope.ts']])('lets a read of %s through', (file) => {
    expect(guard('Read', { file_path: file })).toBeUndefined();
  });

  it('refuses writes and notebook edits to secret files', () => {
    expect(guard('Write', { file_path: '.env' })).toBeDefined();
    expect(guard('Edit', { file_path: '.env' })).toBeDefined();
    expect(guard('NotebookEdit', { notebook_path: 'id_rsa' })).toBeDefined();
  });

  it('uses THREADBASE_CONFIG_DIR as the streamer config dir', () => {
    expect(guardToolUse('Read', { file_path: '/srv/tb/x' }, repo, false, home, { THREADBASE_CONFIG_DIR: '/srv/tb' })).toBeDefined();
  });

  it('refuses searches rooted at or above home, inside secret dirs, or aimed at secret names', () => {
    expect(guard('Grep', { pattern: 'x', path: home })).toBeDefined();
    expect(guard('Glob', { pattern: '**/*', path: '/' })).toBeDefined();
    expect(guard('Grep', { pattern: 'x', path: 'keys' })).toBeDefined();
    expect(guard('Grep', { pattern: 'x', glob: '.env' })).toBeDefined();
    expect(guard('Grep', { pattern: 'x', glob: '**/.env*' })).toBeDefined();
    expect(guard('Grep', { pattern: 'x', glob: '*.{ts,pem}' })).toBeDefined();
    expect(guard('Grep', { pattern: 'x', glob: '.env.example' })).toBeUndefined();
    expect(guard('Grep', { pattern: 'x', glob: '*.ts' })).toBeUndefined();
    expect(guard('Glob', { pattern: '**/.env*' })).toBeUndefined();
    expect(guard('Grep', { pattern: 'TODO' })).toBeUndefined();
    expect(guard('Glob', { pattern: 'src/**/*.ts' })).toBeUndefined();
  });

  it.each([
    ['cat .env'], ['cat ~/.ssh/id_rsa'], ['printenv'], ['env'], ['ls && env'], ['cat /proc/self/environ'],
    ['export -p'], ['cat ~/.threadbase/config.json'], ['cp credentials /tmp'],
  ])('trips on the Bash command %s', (command) => {
    expect(guard('Bash', { command })).toBeDefined();
  });

  it.each([['git status'], ['npm test'], ['cat .env.example'], ['ls src']])('lets the Bash command %s through', (command) => {
    expect(guard('Bash', { command })).toBeUndefined();
  });

  it('refuses the Agent tool only inside a subagent', () => {
    expect(guard('Agent', { prompt: 'x' }, true)).toBeDefined();
    expect(guard('Agent', { prompt: 'x' }, false)).toBeUndefined();
  });

  it('resolves a path through a symlink before checking it', () => {
    expect(isSecretPath('keys/id_ed25519', repo, home, env)).toBe(true);
  });
});

describe('mask', () => {
  it('masks secret env values and API keys, and leaves the rest', () => {
    const e = { MY_API_TOKEN: 'abcdefgh123', HOME: '/Users/someone', SHORT_KEY: 'abc' };
    expect(mask('t=abcdefgh123 h=/Users/someone k=sk-ant-api03-XXXXXXXXXXXX s=abc', e))
      .toBe('t=*** h=/Users/someone k=sk-ant-*** s=abc');
  });
});

describe('redactGrep', () => {
  it('drops secret files from the file list and their lines from the content', () => {
    const out = redactGrep({
      mode: 'content', numFiles: 2, filenames: ['.env', 'src/a.ts'],
      content: '.env:1:TOKEN=abc\nsrc/a.ts:3:TOKEN\nsrc/a.ts-4-ctx\nkeys/id_ed25519-2-x\nconfig/.env.local:x',
    }, repo, home, env);
    expect(out).toEqual({ mode: 'content', numFiles: 1, filenames: ['src/a.ts'], content: 'src/a.ts:3:TOKEN\nsrc/a.ts-4-ctx' });
  });

  it('returns undefined when there is nothing to remove', () => {
    expect(redactGrep({ filenames: ['src/a.ts'], content: 'src/a.ts:1:x' }, repo, home, env)).toBeUndefined();
    expect(redactGrep('text', repo, home, env)).toBeUndefined();
  });
});
