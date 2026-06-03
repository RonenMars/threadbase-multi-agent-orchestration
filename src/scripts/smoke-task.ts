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

async function main() {
  const turnId = nanoid(8);
  const input: TurnInput = {
    sessionId: 'smoke-task-session',
    turnId,
    prompt: 'Write a concise TypeScript function that debounces an async function.',
    conversationHistory: [],
  };

  console.log(`Starting turn ${turnId}...`);
  await startTurn(input);

  const poll = setInterval(async () => {
    try {
      console.log(`  stage: ${await getTurnStage(turnId)}`);
    } catch {
      /* may have completed */
    }
  }, 1000);

  const result = await awaitTurnResult(turnId);
  clearInterval(poll);

  console.log('\n=== RESULT ===');
  console.log(`approved: ${result.review.approved}  reworks: ${result.reworkAttempts}  overruled: ${result.reviewerOverruled}`);
  console.log(result.content);
}

main().catch((err) => { console.error(err); process.exit(1); });
