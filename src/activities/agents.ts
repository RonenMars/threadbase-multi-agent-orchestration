// src/activities/agents.ts
//
// ACTIVITIES = your AI agents.
//
// An Activity is just an async function. It is THE place for all I/O and all
// non-determinism: network calls, DB writes, and — crucially here — LLM calls.
// Temporal retries activities per the policy set in the workflow, so a flaky
// Claude call recovers automatically.
//
// Each agent activity runs a role from roles.yaml on that role's runtime. The
// workflow picks the activity's timeout tier; the activity picks the runtime.
//
// Logging: use Context.current().log — it's the activity-context logger that
// Temporal pre-populates with workflowType / activityType / attempt. The
// Runtime's pino adapter routes it through our shared logger.

import { Context } from '@temporalio/activity';
import { getRole, loadRoles, type Role, type RuntimeName } from '../roles';
import { runtimes, type AgentInput, type AgentResult } from '../runtimes';
import { withHeartbeat } from '../runtimes/heartbeat';
import { mask } from '../runtimes/secrets';
import type { Task, Draft, Review, AgentCall } from '../shared/types';

/** Each role's runtime, so the workflow can pick the activity timeout for it. */
export async function roleRuntimes(): Promise<Record<string, RuntimeName>> {
  return Object.fromEntries(Object.values(loadRoles()).map((r) => [r.name, r.runtime]));
}

/** Whether a role names a stronger model to retry on. */
export async function escalationAvailable(name: string): Promise<boolean> {
  return !!getRole(name).escalationModel;
}

function escalated(role: Role): Role {
  const effort = role.escalationEffort ?? role.effort;
  return { ...role, model: role.escalationModel ?? role.model, ...(effort ? { effort } : {}) };
}

async function runRole(call: AgentCall, input: AgentInput): Promise<{ result: AgentResult; note?: string }> {
  const ctx = Context.current();
  const base = getRole(call.role);
  const role = call.escalate ? escalated(base) : base;
  const sdk = role.runtime === 'agent-sdk' && !!call.cwd;
  const note = role.runtime === 'agent-sdk' && !call.cwd
    ? `The ${role.name} has no project directory for this session, so it ran without tools.`
    : undefined;
  const key = sdk ? `${ctx.info.workflowExecution?.workflowId}:${call.cwd}` : undefined;
  const result = await withHeartbeat(key, (signal, beat) =>
    runtimes[sdk ? 'agent-sdk' : 'text'].run(role, input, {
      cwd: sdk ? call.cwd : undefined,
      signal,
      onMessage: beat,
      log: (line) => ctx.log.debug('agent session stderr', { role: role.name, line }),
    }));
  return { result, note };
}

const errText = (err: unknown) => mask(err instanceof Error ? err.message : String(err));

// --- Worker agent: takes a task, produces a draft ---------------------------
export async function processTask(task: Task, call: AgentCall = { role: 'worker' }): Promise<Draft> {
  const ctx = Context.current();
  const startedAt = Date.now();
  ctx.log.info('processTask start', {
    taskId: task.id,
    sessionId: task.sessionId,
    role: call.role,
    cwd: call.cwd,
    promptLength: task.prompt.length,
  });

  try {
    const { result, note } = await runRole(call, {
      prompt: `${task.context ?? ''}\n\n${task.prompt}`.trim(),
      maxTokens: 4096,
    });
    ctx.log.info('processTask done', {
      taskId: task.id,
      sessionId: task.sessionId,
      durationMs: Date.now() - startedAt,
      ...result.stats,
      contentLength: result.content.length,
    });
    return { taskId: task.id, content: result.content, ...(note ? { note } : {}) };
  } catch (err) {
    ctx.log.error('processTask failed', {
      taskId: task.id,
      sessionId: task.sessionId,
      durationMs: Date.now() - startedAt,
      err: errText(err),
    });
    throw err;
  }
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, notes: { type: 'string' } },
  required: ['approved', 'notes'],
  additionalProperties: false,
};

// --- Reviewer agent: inspects a draft, returns a verdict --------------------
export async function reviewTask(draft: Draft, call: AgentCall = { role: 'reviewer' }): Promise<Review> {
  const ctx = Context.current();
  const startedAt = Date.now();
  ctx.log.info('reviewTask start', {
    taskId: draft.taskId,
    role: call.role,
    cwd: call.cwd,
    draftLength: draft.content.length,
  });

  try {
    const { result, note } = await runRole(call, {
      prompt:
        'Review the following work for correctness and quality. ' +
        'Respond ONLY with JSON: {"approved": boolean, "notes": string}. ' +
        'No prose, no markdown fences.\n\n' +
        draft.content,
      maxTokens: 1024,
      schema: VERDICT_SCHEMA,
    });
    const baseMeta = { taskId: draft.taskId, durationMs: Date.now() - startedAt, ...result.stats };
    const withNote = (r: Review): Review => (note ? { ...r, note } : r);

    if (result.structured) {
      const parsed = result.structured as { approved: boolean; notes?: string };
      const review = withNote({ taskId: draft.taskId, approved: !!parsed.approved, notes: parsed.notes ?? '' });
      ctx.log.info('reviewTask done', { ...baseMeta, approved: review.approved, notesLength: review.notes.length });
      return review;
    }

    const raw = result.content.replace(/```json|```/g, '').trim();
    try {
      const parsed = JSON.parse(raw) as { approved: boolean; notes: string };
      const review = withNote({
        taskId: draft.taskId,
        approved: !!parsed.approved,
        notes: parsed.notes ?? '',
      });
      ctx.log.info('reviewTask done', {
        ...baseMeta,
        approved: review.approved,
        notesLength: review.notes.length,
      });
      return review;
    } catch {
      // Reviewer didn't return clean JSON. Fail open into a rework loop.
      ctx.log.warn('reviewTask unparseable JSON, failing open to rework', {
        ...baseMeta,
        rawLength: raw.length,
      });
      return withNote({ taskId: draft.taskId, approved: false, notes: `Unparseable review: ${raw}` });
    }
  } catch (err) {
    ctx.log.error('reviewTask failed', {
      taskId: draft.taskId,
      durationMs: Date.now() - startedAt,
      err: errText(err),
    });
    throw err;
  }
}

// --- PM agent: final sign-off ---------------------------------------------
export async function productSignOff(_draft: Draft, review: Review): Promise<boolean> {
  // No LLM call here yet — milestone B uses the review verdict directly.
  // Logging at debug because there's nothing interesting unless wired to an
  // actual sign-off agent later.
  Context.current().log.debug('productSignOff', {
    taskId: review.taskId,
    approved: review.approved,
  });
  return review.approved;
}
