// test/scripts/mock-receiver.test.ts
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { config } from '../../src/shared/config';
import { server, verify } from '../../src/scripts/mock-receiver';

const body = Buffer.from(JSON.stringify({ eventId: 'evt_mock', sessionId: 's', turnId: 't' }));
const hmac = (data: string | Buffer) =>
  crypto.createHmac('sha256', config.progressHmacSecret).update(data).digest('hex');

describe('mock receiver verify', () => {
  const now = Math.floor(Date.now() / 1000);
  const ts = String(now);

  it('accepts a signature over `${timestamp}.${body}`', () => {
    expect(verify(body, hmac(`${ts}.${body.toString('utf8')}`), ts, now)).toBe(true);
  });

  it('rejects a body-only signature', () => {
    expect(verify(body, hmac(body), ts, now)).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    expect(verify(body, hmac(`.${body.toString('utf8')}`), '', now)).toBe(false);
  });

  it('rejects a non-integer timestamp', () => {
    const bad = `${now}.5`;
    expect(verify(body, hmac(`${bad}.${body.toString('utf8')}`), bad, now)).toBe(false);
  });

  it('rejects a stale timestamp even when it is signed correctly', () => {
    const old = String(now - 301);
    expect(verify(body, hmac(`${old}.${body.toString('utf8')}`), old, now)).toBe(false);
  });

  it('rejects a signature made for a different timestamp', () => {
    const other = String(now - 10);
    expect(verify(body, hmac(`${other}.${body.toString('utf8')}`), ts, now)).toBe(false);
  });
});

describe('mock receiver HTTP', () => {
  it('reads X-Timestamp from the request: 200 for the new signature, 401 for body-only', async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const ts = String(Math.floor(Date.now() / 1000));
      const post = (signature: string) =>
        fetch(`http://127.0.0.1:${port}/internal/sessions/s/progress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-progress-signature': signature },
          body,
        }).then((res) => res.status);

      expect(await post(hmac(`${ts}.${body.toString('utf8')}`))).toBe(200);
      expect(await post(hmac(body))).toBe(401);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
