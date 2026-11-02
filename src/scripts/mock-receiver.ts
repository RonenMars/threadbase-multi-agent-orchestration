// src/scripts/mock-receiver.ts
//
// A tiny HTTP server that mimics tb-streamer's webhook receiver for local
// smoke testing. Verifies the HMAC over `${X-Timestamp}.${body}` and the
// timestamp's freshness, prints received events, returns 200.
//
// Run:
//   npm run smoke:receiver
//
// Then run worker + smoke:session in other terminals.

import '../shared/load-env';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { config } from '../shared/config';
import { logger as rootLogger } from '../shared/logger';

const log = rootLogger.child({ proc: 'mock-receiver' });
const PORT = Number(process.env.MOCK_RECEIVER_PORT ?? 3456);

const TIMESTAMP_SKEW_SECONDS = 300;

export function verify(
  body: Buffer,
  signature: string,
  timestamp: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > TIMESTAMP_SKEW_SECONDS) return false;
  const expected = crypto
    .createHmac('sha256', config.progressHmacSecret)
    .update(`${timestamp}.${body.toString('utf8')}`)
    .digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const signature = String(req.headers['x-progress-signature'] ?? '');
    const timestamp = String(req.headers['x-timestamp'] ?? '');
    if (!verify(body, signature, timestamp)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      log.warn({ method: req.method, url: req.url }, 'webhook 401 — bad signature or stale timestamp');
      return;
    }
    try {
      const event = JSON.parse(body.toString('utf8'));
      log.info(
        {
          type: event.type,
          seq: event.seq,
          turnId: event.turnId,
          sessionId: event.sessionId,
          stage: event.stage,
          reworkAttempt: event.reworkAttempt,
          contentPreview: (event.payload?.content ?? '').slice(0, 80).replace(/\n/g, ' '),
        },
        'webhook received',
      );
    } catch (err) {
      log.error({ err }, 'webhook body parse error');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

// Listen only when run as a script, so tests can import `verify`.
if (require.main === module) {
  server.listen(PORT, () => {
    log.info(
      { port: PORT, endpoint: `http://localhost:${PORT}/internal/sessions/:sessionId/progress` },
      'mock receiver up',
    );
  });
}
