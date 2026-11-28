// src/roles.ts
//
// Roles are data keyed by any string, read from roles.yaml (or ROLES_FILE).
// Adding a role means adding a key to that file; no code changes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export type RuntimeName = 'text' | 'agent-sdk';

export interface Role {
  name: string;
  runtime: RuntimeName;
  model?: string;
  /** The prompt file's contents. */
  prompt?: string;
  tools?: string[];
  allow?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** What an escalated retry runs on. Without a model there is no retry option. */
  escalationModel?: string;
  escalationEffort?: Role['effort'];
  maxBudgetUsd?: number;
  maxTurns?: number;
  mcpServers?: Record<string, { url: string; headers?: Record<string, string> }>;
}

const RUNTIMES: RuntimeName[] = ['text', 'agent-sdk'];

export function rolesFile(): string {
  return process.env.ROLES_FILE ?? path.resolve(__dirname, '../roles.yaml');
}

/** Every role in the file. Read on each call, so an edit applies to the next turn. */
export function loadRoles(file = rolesFile()): Record<string, Role> {
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, Partial<Role> & { prompt?: string }>;
  const roles: Record<string, Role> = {};
  for (const [name, r] of Object.entries(raw)) {
    const runtime = r.runtime ?? 'text';
    if (!RUNTIMES.includes(runtime)) {
      throw new Error(`${file}: role "${name}" has runtime "${runtime}"; expected one of ${RUNTIMES.join(', ')}`);
    }
    const prompt = r.prompt ? readFileSync(path.resolve(path.dirname(file), r.prompt), 'utf8') : undefined;
    roles[name] = { ...r, name, runtime, prompt };
  }
  return roles;
}

/** A role the file does not name runs as a plain text agent. */
export function getRole(name: string, file?: string): Role {
  return loadRoles(file)[name] ?? { name, runtime: 'text' };
}
