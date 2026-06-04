// src/scripts/smoke-task.ts
//
// Single-turn smoke test against the new turnWorkflow directly.
// Useful for verifying the legacy pipeline path still works.
//
// Prereqs:
//   `temporal server start-dev` running
//   `npm run worker` running in another terminal
//   ANTHROPIC_API_KEY set
//
// Run:
//   npm run smoke:task

import '../shared/load-env';
import { nanoid } from 'nanoid';
import { startTurn, awaitTurnResult, getTurnStage } from '../client';
import type { TurnInput } from '../shared/types';
import { logger as rootLogger } from '../shared/logger';

const log = rootLogger.child({ proc: 'smoke-task' });

async function main() {
  const turnId = nanoid(8);
  const input: TurnInput = {
    sessionId: 'smoke-task-session',
    turnId,
    prompt: 'Write a concise TypeScript function that debounces an async function.',
    conversationHistory: [],
  };

  log.info({ turnId }, 'starting turn');
  await startTurn(input);

  const poll = setInterval(async () => {
    try {
      const stage = await getTurnStage(turnId);
      log.info({ turnId, stage }, 'polled turn stage');
    } catch (err) {
      // May have completed; query handle goes away.
      log.debug({ turnId, err }, 'getTurnStage transient error');
    }
  }, 1000);

  const result = await awaitTurnResult(turnId);
  clearInterval(poll);

  log.info(
    {
      turnId,
      approved: result.review.approved,
      reworkAttempts: result.reworkAttempts,
      reviewerOverruled: result.reviewerOverruled,
      contentLength: result.content.length,
    },
    'turn finished',
  );
  // For the actual content, log at info too — useful for quick visual diff.
  log.info({ turnId, content: result.content }, 'final answer');
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'smoke-task crashed');
  process.exit(1);
});
