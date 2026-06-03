// src/scripts/smoke-session.ts
//
// End-to-end smoke for the multi-agent session:
// 1. Start an orchestrator session.
// 2. Send two userInput signals back-to-back.
// 3. Watch progress events arrive at the mock receiver (run in another terminal).
//
// Prereqs:
//   `temporal server start-dev` running
//   `npm run smoke:receiver` running in another terminal
//   `npm run worker` running in another terminal
//   ANTHROPIC_API_KEY set
//
// Run:
//   npm run smoke:session

import '../shared/load-env';
import { nanoid } from 'nanoid';
import { startSession, sendUserInput, endSession, getSessionStage } from '../client';

async function main() {
  const sessionId = `smoke-${nanoid(6)}`;
  console.log(`Starting session ${sessionId}...`);
  await startSession(sessionId);

  const turn1 = `turn-${nanoid(6)}`;
  const turn2 = `turn-${nanoid(6)}`;

  console.log('Sending two signals back-to-back...');
  await sendUserInput(sessionId, {
    turnId: turn1,
    prompt: 'Write a one-line TypeScript debounce function.',
    conversationHistory: [],
  });
  await sendUserInput(sessionId, {
    turnId: turn2,
    prompt: 'Now do the same for throttle.',
    conversationHistory: [{ role: 'user', content: 'Write a one-line TypeScript debounce function.' }],
  });

  // Poll the stage for ~60s so the human can watch.
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      console.log(`  session stage: ${await getSessionStage(sessionId)}`);
    } catch {
      /* might be transient */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('Ending session...');
  await endSession(sessionId);
}

main().catch((err) => { console.error(err); process.exit(1); });
