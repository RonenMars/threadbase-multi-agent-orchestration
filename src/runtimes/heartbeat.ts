// src/runtimes/heartbeat.ts
//
// Runs an agent inside a Temporal activity: heartbeats while it works, aborts
// it when the activity is cancelled, keeps one live session per workflow and
// directory, and makes a session's own limits non-retryable.

import { ApplicationFailure, Context } from '@temporalio/activity';
import { AgentLimitError } from './agent-sdk';

/** A third of the activities' 60 s heartbeat timeout. */
const HEARTBEAT_EVERY_MS = 20_000;
/** Covers the SDK's SIGTERM-then-SIGKILL shutdown of an older session, with a margin. */
const ABORT_WAIT_MS = 10_000;

const live = new Map<string, { abort: AbortController; done: Promise<unknown> }>();

/**
 * @param key  Set for sessions that work in a directory: a newer attempt under
 *             the same key aborts the older one before it starts.
 */
export async function withHeartbeat<T>(
  key: string | undefined,
  fn: (signal: AbortSignal, beat: (details?: unknown) => void) => Promise<T>,
): Promise<T> {
  const ctx = Context.current();
  const abort = new AbortController();
  const onCancel = () => abort.abort();
  ctx.cancellationSignal.addEventListener('abort', onCancel);
  const beat = (details?: unknown) => ctx.heartbeat(details);
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  beat();

  try {
    const prev = key ? live.get(key) : undefined;
    if (prev) {
      prev.abort.abort();
      let waited: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([prev.done.catch(() => {}), new Promise((r) => { waited = setTimeout(r, ABORT_WAIT_MS); })]);
      clearTimeout(waited);
    }
    if (abort.signal.aborted) throw new Error('cancelled before the session started');
    const done = fn(abort.signal, beat);
    if (key) live.set(key, { abort, done });
    return await done;
  } catch (err) {
    if (err instanceof AgentLimitError) throw ApplicationFailure.nonRetryable(err.message, 'AgentLimit');
    throw err;
  } finally {
    clearInterval(timer);
    ctx.cancellationSignal.removeEventListener('abort', onCancel);
    if (key && live.get(key)?.abort === abort) live.delete(key);
  }
}
