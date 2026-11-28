// CI skips the suite only when every changed file is listed in .github/ci-skip-paths.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

function skips(...changed: string[]): boolean {
  const out = execFileSync(process.execPath, ['.github/scripts/ci-skip.js', '.github/ci-skip-paths'], {
    cwd: root,
    input: changed.map((f) => `${f}\n`).join(''),
    encoding: 'utf8',
  });
  expect(out.trim()).toMatch(/^(true|false)$/);
  return out.trim() === 'true';
}

describe('CI skip gate', () => {
  it('skips a docs-only change', () => {
    expect(skips('docs/ROADMAP.md', 'docs/release-notes/a.md', 'README.md', 'CLAUDE.md')).toBe(true);
  });

  it.each([
    ['src/engine/run.ts'],
    ['test/engine/run.test.ts'],
    ['package-lock.json'],
    ['roles.yaml'],
    ['prompts/reviewer.md'],
    ['src/README.md'],
    ['docs-old/a.md'],
    ['.github/workflows/ci.yml'],
  ])('runs for %s', (file) => {
    expect(skips(file)).toBe(false);
  });

  it('runs when docs change alongside code', () => {
    expect(skips('docs/ROADMAP.md', 'src/roles.ts')).toBe(false);
  });

  it('runs when the list of changed files is empty', () => {
    expect(skips()).toBe(false);
  });

  it.each([['.github/ci-skip-paths'], ['.github/scripts/ci-skip.js']])('runs when the gate itself changes: %s', (file) => {
    expect(skips('docs/ROADMAP.md', file)).toBe(false);
  });
});
