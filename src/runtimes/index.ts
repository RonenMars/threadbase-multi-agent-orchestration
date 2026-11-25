// src/runtimes/index.ts
//
// The seam every agent runs behind. A role names its runtime; callers only
// see AgentRuntime.run().

import type { Role, RuntimeName } from '../roles';
import { textRuntime } from './text';
import { agentSdkRuntime } from './agent-sdk';

export interface AgentInput {
  prompt: string;
  /** Text runtime only. */
  maxTokens?: number;
  /** A JSON schema the answer must match (agent-sdk); the text runtime relies on the prompt. */
  schema?: Record<string, unknown>;
}

export interface AgentContext {
  /** The directory the session works in. Required by agent-sdk. */
  cwd?: string;
  signal?: AbortSignal;
  /** An agent-sdk session id to continue. */
  resume?: string;
  /** Called on every message a session produces; the activity heartbeats from it. */
  onMessage?: (type: string) => void;
  log?: (message: string) => void;
}

export interface AgentResult {
  content: string;
  costUsd: number;
  sessionId?: string;
  /** The parsed answer when `schema` was given. */
  structured?: unknown;
  /** Extra fields for the caller's log line. */
  stats?: Record<string, unknown>;
}

export interface AgentRuntime {
  run(role: Role, input: AgentInput, ctx: AgentContext): Promise<AgentResult>;
}

export const runtimes: Record<RuntimeName, AgentRuntime> = {
  text: textRuntime,
  'agent-sdk': agentSdkRuntime,
};
