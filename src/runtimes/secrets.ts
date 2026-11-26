// src/runtimes/secrets.ts
//
// What an agent session may not touch, and how secrets are masked in logs.
// Pure functions: the agent-sdk runtime wires them into a PreToolUse hook.

import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Paths under home that hold credentials. The streamer's config dir is added at call time. */
const HOME_SECRETS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '.docker/config.json', '.config/gh', '.claude/.credentials.json',
];

const SECRET_NAME = /^(\.env(?!\.(example|sample|template)$)(\..*)?|.*\.pem|.*\.key|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials(\.json)?)$/i;

/** A glob that could match a secret file name, wildcards included. */
const SECRET_GLOB = /(^|[/{,])(\.env(?!\.(example|sample|template)\b)|id_(rsa|ed25519|ecdsa|dsa)|credentials)|[.,{](pem|key)\b/i;

function secretRoots(home: string, env: NodeJS.ProcessEnv): string[] {
  return [...HOME_SECRETS.map((p) => path.join(home, p)), env.THREADBASE_CONFIG_DIR ?? path.join(home, '.threadbase')];
}

/** Resolves symlinks, using the deepest parent that exists for paths not created yet. */
function real(p: string): string {
  let dir = p;
  const rest: string[] = [];
  while (!existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return path.join(existsSync(dir) ? realpathSync(dir) : dir, ...rest);
}

const inside = (p: string, root: string) => {
  const rel = path.relative(root, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

export function isSecretPath(p: string, cwd: string, home = os.homedir(), env = process.env): boolean {
  const abs = real(path.resolve(cwd, p.replace(/^~(?=$|\/)/, home)));
  // /proc and /sys expose other processes' environments, the worker's included.
  return SECRET_NAME.test(path.basename(abs)) || ['/proc', '/sys', ...secretRoots(home, env)].some((root) => inside(abs, real(root)));
}

// ponytail: a tripwire over the command text, not a boundary; give a role Bash only if it needs it.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const BASH_SECRET = new RegExp(
  String.raw`(^|[\s'"=/<>|;&(.])(\.env(?!\.(example|sample|template)\b)\b|${[...HOME_SECRETS, '.threadbase'].map(esc).join('|')}\b|credentials\b|id_(rsa|ed25519|ecdsa|dsa)\b)` +
    String.raw`|\.(pem|key)\b|\bprintenv\b|\/(proc|sys)\/|\/environ\b|(^|[;&|]\s*)(env|set|export -p)\s*($|[;&|])`,
);

/**
 * Why a tool call must be refused, or undefined to let it through.
 * `inSubagent` is true when a subagent made the call: subagents get no Agent tool (depth 1).
 */
export function guardToolUse(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  inSubagent = false,
  home = os.homedir(),
  env = process.env,
): string | undefined {
  if (tool === 'Agent' && inSubagent) return 'subagents may not start subagents';
  if (tool === 'Bash') {
    return BASH_SECRET.test(String(input.command ?? '')) ? 'the command touches secrets or the environment' : undefined;
  }
  const file = input.file_path ?? input.notebook_path;
  if (typeof file === 'string' && isSecretPath(file, cwd, home, env)) return `${file} holds secrets`;
  if (tool === 'Grep' || tool === 'Glob') {
    const root = real(path.resolve(cwd, String(input.path ?? '.')));
    // A search rooted at or above home would read the credential folders under it.
    if (inside(real(home), root)) return 'searches may not start at or above the home directory';
    if (isSecretPath(root, cwd, home, env)) return `${input.path} holds secrets`;
    // Glob returns names only; Grep returns contents, so its file filter may not aim at secrets.
    if (tool === 'Grep' && SECRET_GLOB.test(String(input.glob ?? ''))) return `${input.glob} names secret files`;
  }
  return undefined;
}

/**
 * Grep reads every file under its root, secret files included, so its output
 * is filtered after it runs: no secret file name, and no line from one.
 * Returns undefined when nothing needed removing.
 */
export function redactGrep(output: unknown, cwd: string, home = os.homedir(), env = process.env): unknown {
  if (!output || typeof output !== 'object') return undefined;
  const o = output as { filenames?: string[]; content?: string; numFiles?: number };
  const secret = (p: string) => isSecretPath(p, cwd, home, env);
  // Content lines start with the file path, then ":" or "-12-". A path can hold either,
  // so every prefix ending at a separator is checked: a line is dropped if any is secret.
  const fromSecret = (line: string) => [...line.matchAll(/:|-\d+-/g)].some((m) => secret(line.slice(0, m.index)));
  const filenames = o.filenames?.filter((f) => !secret(f));
  const content = o.content?.split('\n').filter((l) => !fromSecret(l)).join('\n');
  if (filenames?.length === o.filenames?.length && content === o.content) return undefined;
  return { ...o, filenames, content, numFiles: filenames?.length ?? o.numFiles };
}

const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Masks secret env values and API-key-shaped strings. */
export function mask(text: string, env = process.env): string {
  let out = text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***');
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_VAR.test(name)) out = out.split(value).join('***');
  }
  return out;
}
