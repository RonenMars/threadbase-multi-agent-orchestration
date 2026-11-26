// test/runtimes/heartbeat.test.ts
import { describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { withHeartbeat } from '../../src/runtimes/heartbeat';

const untilAborted = (signal: AbortSignal) => new Promise<string>((_, reject) =>
  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

describe('withHeartbeat', () => {
  it('heartbeats on start and on each beat', async () => {
    const env = new MockActivityEnvironment();
    let beats = 0;
    env.on('heartbeat', () => beats++);
    await env.run(() => withHeartbeat(undefined, async (_s, beat) => { beat(); return 'ok'; }));
    expect(beats).toBe(2);
  });

  it('aborts the session when the activity is cancelled', async () => {
    const env = new MockActivityEnvironment();
    const running = env.run(() => withHeartbeat(undefined, untilAborted));
    await new Promise((r) => setTimeout(r, 10));
    env.cancel();
    await expect(running).rejects.toThrow();
  });

  it('aborts the older session under the same key before starting the newer one', async () => {
    let olderAborted = false;
    const older = new MockActivityEnvironment().run(() => withHeartbeat('wf:/repo', (s) =>
      untilAborted(s).catch((e) => { olderAborted = true; throw e; })));
    await new Promise((r) => setTimeout(r, 10));
    const newer = await new MockActivityEnvironment().run(() => withHeartbeat('wf:/repo', async () => 'newer'));
    expect(newer).toBe('newer');
    expect(olderAborted).toBe(true);
    await expect(older).rejects.toThrow();
  });

  it('leaves sessions under other keys running', async () => {
    const ac = new AbortController();
    let otherAborted = false;
    const other = new MockActivityEnvironment().run(() => withHeartbeat('wf:/a', (s) =>
      Promise.race([untilAborted(s).catch((e) => { otherAborted = true; throw e; }), untilAborted(ac.signal)])));
    await new MockActivityEnvironment().run(() => withHeartbeat('wf:/b', async () => 'b'));
    expect(otherAborted).toBe(false);
    ac.abort();
    await other.catch(() => {});
  });
});
