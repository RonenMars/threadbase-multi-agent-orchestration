// src/scripts/mock-receiver.ts
//
// A tiny HTTP server that mimics tb-streamer's webhook receiver for local
// smoke testing. Verifies HMAC, prints received events, returns 200.
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

function verify(body: Buffer, signature: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', config.progressHmacSecret).update(body).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const signature = String(req.headers['x-progress-signature'] ?? '');
    if (!verify(body, signature)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      log.warn({ method: req.method, url: req.url }, 'webhook 401 — bad signature');
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

server.listen(PORT, () => {
  log.info(
    { port: PORT, endpoint: `http://localhost:${PORT}/internal/sessions/:sessionId/progress` },
    'mock receiver up',
  );
});
