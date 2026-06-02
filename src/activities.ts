// ============================================================================
// ACTIVITIES = your AI agents.
//
// An Activity is just an async function. It is THE place for all I/O and all
// non-determinism: network calls, DB writes, and — crucially here — LLM calls.
// Temporal retries activities per the policy set in the workflow, so a flaky
// Claude call recovers automatically.
//
// Non-determinism is fine in activities (unlike workflow code).
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { Context } from '@temporalio/activity';
import { config } from './shared/config';
import type { Task, Draft, Review } from './shared/types';

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from env

function textOf(msg: Anthropic.Message): string {
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

// --- Worker agent: takes a task, produces a draft ---------------------------
export async function processTask(task: Task): Promise<Draft> {
  Context.current().heartbeat('processing'); // signal liveness on long calls
  const msg = await claude.messages.create({
    model: config.model,
    max_tokens: 4096,
    messages: [
      { role: 'user', content: `${task.context ?? ''}\n\n${task.prompt}`.trim() },
    ],
  });
  return { taskId: task.id, content: textOf(msg) };
}

// --- Reviewer agent: inspects a draft, returns a verdict --------------------
export async function reviewTask(draft: Draft): Promise<Review> {
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
  try {
    const parsed = JSON.parse(raw) as { approved: boolean; notes: string };
    return { taskId: draft.taskId, approved: !!parsed.approved, notes: parsed.notes ?? '' };
  } catch {
    // If the reviewer didn't return clean JSON, fail open into a rework loop.
    return { taskId: draft.taskId, approved: false, notes: `Unparseable review: ${raw}` };
  }
}

// --- PM agent: final sign-off (stub — extend with real logic or a human gate)
export async function productSignOff(_draft: Draft, review: Review): Promise<boolean> {
  return review.approved;
}
