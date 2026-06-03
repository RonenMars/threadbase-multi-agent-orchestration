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
      console.error(`[mock-receiver] 401 ${req.method} ${req.url}`);
      return;
    }
    try {
      const event = JSON.parse(body.toString('utf8'));
      console.log(`[mock-receiver] ${event.type.padEnd(18)} seq=${String(event.seq).padStart(2)} turn=${event.turnId} stage=${event.stage ?? '-'} content=${(event.payload?.content ?? '').slice(0, 60).replace(/\n/g, ' ')}`);
    } catch (err) {
      console.error('[mock-receiver] parse error', err);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(PORT, () => {
  console.log(`Mock receiver up on http://localhost:${PORT}/internal/sessions/:sessionId/progress`);
});
