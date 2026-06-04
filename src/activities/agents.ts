// src/activities/agents.ts
//
// ACTIVITIES = your AI agents.
//
// An Activity is just an async function. It is THE place for all I/O and all
// non-determinism: network calls, DB writes, and — crucially here — LLM calls.
// Temporal retries activities per the policy set in the workflow, so a flaky
// Claude call recovers automatically.
//
// Logging: use Context.current().log — it's the activity-context logger that
// Temporal pre-populates with workflowType / activityType / attempt. The
// Runtime's pino adapter routes it through our shared logger.

import Anthropic from '@anthropic-ai/sdk';
import { Context } from '@temporalio/activity';
import { config } from '../shared/config';
import type { Task, Draft, Review } from '../shared/types';

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from env

function textOf(msg: Anthropic.Message): string {
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

// --- Worker agent: takes a task, produces a draft ---------------------------
export async function processTask(task: Task): Promise<Draft> {
  const ctx = Context.current();
  ctx.heartbeat('processing');
  const startedAt = Date.now();
  ctx.log.info('processTask start', {
    taskId: task.id,
    sessionId: task.sessionId,
    model: config.model,
    promptLength: task.prompt.length,
  });

  try {
    const msg = await claude.messages.create({
      model: config.model,
      max_tokens: 4096,
      messages: [
        { role: 'user', content: `${task.context ?? ''}\n\n${task.prompt}`.trim() },
      ],
    });
    const content = textOf(msg);

    ctx.log.info('processTask done', {
      taskId: task.id,
      sessionId: task.sessionId,
      durationMs: Date.now() - startedAt,
      inputTokens: msg.usage?.input_tokens,
      outputTokens: msg.usage?.output_tokens,
      stopReason: msg.stop_reason,
      contentLength: content.length,
    });

    return { taskId: task.id, content };
  } catch (err) {
    ctx.log.error('processTask failed', {
      taskId: task.id,
      sessionId: task.sessionId,
      durationMs: Date.now() - startedAt,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// --- Reviewer agent: inspects a draft, returns a verdict --------------------
export async function reviewTask(draft: Draft): Promise<Review> {
  const ctx = Context.current();
  const startedAt = Date.now();
  ctx.log.info('reviewTask start', {
    taskId: draft.taskId,
    model: config.model,
    draftLength: draft.content.length,
  });

  try {
    const msg = await claude.messages.create({
      model: config.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content:
            'Review the following work for correctness and quality. ' +
            'Respond ONLY with JSON: {"approved": boolean, "notes": string}. ' +
            'No prose, no markdown fences.\n\n' +
            draft.content,
        },
      ],
    });

    const raw = textOf(msg).replace(/```json|```/g, '').trim();
    const baseMeta = {
      taskId: draft.taskId,
      durationMs: Date.now() - startedAt,
      inputTokens: msg.usage?.input_tokens,
      outputTokens: msg.usage?.output_tokens,
    };

    try {
      const parsed = JSON.parse(raw) as { approved: boolean; notes: string };
      const review: Review = {
        taskId: draft.taskId,
        approved: !!parsed.approved,
        notes: parsed.notes ?? '',
      };
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
      return { taskId: draft.taskId, approved: false, notes: `Unparseable review: ${raw}` };
    }
  } catch (err) {
    ctx.log.error('reviewTask failed', {
      taskId: draft.taskId,
      durationMs: Date.now() - startedAt,
      err: err instanceof Error ? err.message : String(err),
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
