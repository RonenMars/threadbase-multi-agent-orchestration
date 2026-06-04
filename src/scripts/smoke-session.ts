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
import { logger as rootLogger } from '../shared/logger';

const log = rootLogger.child({ proc: 'smoke-session' });

async function main() {
  const sessionId = `smoke-${nanoid(6)}`;
  log.info({ sessionId }, 'starting session');
  await startSession(sessionId);

  const turn1 = `turn-${nanoid(6)}`;
  const turn2 = `turn-${nanoid(6)}`;

  log.info({ sessionId, turn1, turn2 }, 'sending two signals back-to-back');
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
      const stage = await getSessionStage(sessionId);
      log.info({ sessionId, stage }, 'polled session stage');
    } catch (err) {
      // Transient — workflow may be mid-transition. Log at debug.
      log.debug({ sessionId, err }, 'getSessionStage transient error');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  log.info({ sessionId }, 'ending session');
  await endSession(sessionId);
}

main().catch((err) => {
  rootLogger.fatal({ err }, 'smoke-session crashed');
  process.exit(1);
});
