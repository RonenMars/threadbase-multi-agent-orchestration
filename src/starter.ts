// ============================================================================
// STARTER — a tiny script to prove the loop end-to-end.
//
// Prereqs:  docker compose up -d   (Temporal running)
//           npm run worker         (agent worker running, in another terminal)
//           ANTHROPIC_API_KEY set in your environment
//
// Run it:   npm run kickoff
//
// Watch it live in the Web UI at http://localhost:8080
// ============================================================================

import './shared/load-env'; // MUST be first — loads .env before any other module reads process.env
import { nanoid } from 'nanoid';
import { startTask, getStage, awaitResult } from './client';
import type { Task } from './shared/types';

async function main() {
  const task: Task = {
    id: nanoid(8),
    sessionId: 'demo-session',
    prompt: 'Write a concise TypeScript function that debounces an async function.',
  };

  console.log(`Starting pipeline for task ${task.id}...`);
  const workflowId = await startTask(task);
  console.log(`Workflow started: ${workflowId}`);

  // Poll the stage a few times so you can see it advance.
  const poll = setInterval(async () => {
    try {
      console.log(`  stage: ${await getStage(task.id)}`);
    } catch {
      /* workflow may have completed; ignore */
    }
  }, 1000);

  const result = await awaitResult(task.id);
  clearInterval(poll);

  console.log('\n=== RESULT ===');
  console.log(`approved: ${result.review.approved}  rework: ${result.reworkAttempts}`);
  console.log(result.content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
