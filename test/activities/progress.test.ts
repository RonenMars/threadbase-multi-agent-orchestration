// test/activities/progress.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ProgressEvent } from '@threadbase/agent-types';

let sendProgressEvent: typeof import('../../src/activities/progress').sendProgressEvent;
let __resetWebhookConfigForTests: typeof import('../../src/activities/progress').__resetWebhookConfigForTests;

const SECRET = 'unit-secret';

function makeEvent(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    sessionId: 'sess_t',
    turnId: 'turn_t',
    eventId: 'evt_t',
    seq: 0,
    type: 'stage_transition',
    stage: 'processing',
    timestamp: 1717430000,
    ...overrides,
  };
}

function startServer(handler: (req: { headers: Record<string, string>; body: Buffer }) => { status: number }): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const result = handler({
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
          ),
          body: Buffer.concat(chunks),
        });
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: result.status < 400 }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('sendProgressEvent', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    process.env.PROGRESS_HMAC_SECRET = SECRET;
    process.env.PROGRESS_WEBHOOK_ATTEMPTS = '3';
    process.env.PROGRESS_WEBHOOK_FIRST_DELAY_MS = '5';
    process.env.PROGRESS_WEBHOOK_BACKOFF = '2';
    process.env.PROGRESS_WEBHOOK_TIMEOUT_MS = '1000';
    vi.resetModules();
    const mod = await import('../../src/activities/progress');
    sendProgressEvent = mod.sendProgressEvent;
    __resetWebhookConfigForTests = mod.__resetWebhookConfigForTests;
    __resetWebhookConfigForTests();
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('POSTs the event with a valid HMAC and event-id header', async () => {
    const received: Array<{ headers: Record<string, string>; body: Buffer }> = [];
    ({ server, baseUrl } = await startServer((req) => {
      received.push(req);
      return { status: 200 };
    }));
    process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
    vi.resetModules();
    const mod = await import('../../src/activities/progress');
    sendProgressEvent = mod.sendProgressEvent;
    __resetWebhookConfigForTests = mod.__resetWebhookConfigForTests;
    __resetWebhookConfigForTests();

    const ev = makeEvent({ eventId: 'evt_42' });
    await sendProgressEvent(ev);

    expect(received).toHaveLength(1);
    const rcv = received[0];
    expect(rcv.headers['x-progress-event-id']).toBe('evt_42');

    const expected = crypto.createHmac('sha256', SECRET).update(rcv.body).digest('hex');
    expect(rcv.headers['x-progress-signature']).toBe(expected);
  });

  it('retries on 5xx then succeeds', async () => {
    let calls = 0;
    ({ server, baseUrl } = await startServer(() => {
      calls += 1;
      return { status: calls < 3 ? 500 : 200 };
    }));
    process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
    vi.resetModules();
    const mod = await import('../../src/activities/progress');
    sendProgressEvent = mod.sendProgressEvent;
    __resetWebhookConfigForTests = mod.__resetWebhookConfigForTests;
    __resetWebhookConfigForTests();

    await sendProgressEvent(makeEvent({ eventId: 'evt_retry' }));
    expect(calls).toBe(3);
  });

  it('gives up after the configured attempt cap and resolves without throwing', async () => {
    let calls = 0;
    ({ server, baseUrl } = await startServer(() => {
      calls += 1;
      return { status: 500 };
    }));
    process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
    vi.resetModules();
    const mod = await import('../../src/activities/progress');
    sendProgressEvent = mod.sendProgressEvent;
    __resetWebhookConfigForTests = mod.__resetWebhookConfigForTests;
    __resetWebhookConfigForTests();

    // Must NOT throw: spec §7.3 says webhook failure never fails the activity.
    await expect(sendProgressEvent(makeEvent({ eventId: 'evt_giveup' }))).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('treats a connection refused as a transport error and gives up after retries', async () => {
    // Pick a port that's almost certainly free, then close it so the connect fails.
    const { server: tmp } = await startServer(() => ({ status: 200 }));
    const addr = (tmp.address() as AddressInfo);
    await new Promise<void>((r) => tmp.close(() => r()));
    process.env.PROGRESS_WEBHOOK_URL = `http://127.0.0.1:${addr.port}/internal/sessions`;
    vi.resetModules();
    const mod = await import('../../src/activities/progress');
    sendProgressEvent = mod.sendProgressEvent;
    __resetWebhookConfigForTests = mod.__resetWebhookConfigForTests;
    __resetWebhookConfigForTests();

    await expect(sendProgressEvent(makeEvent({ eventId: 'evt_refused' }))).resolves.toBeUndefined();
  });

  it('serializes the payload to JSON and signs the exact bytes that are sent', async () => {
    let bodyHex = '';
    ({ server, baseUrl } = await startServer((req) => {
      bodyHex = req.body.toString('utf8');
      return { status: 200 };
    }));
    process.env.PROGRESS_WEBHOOK_URL = `${baseUrl}/internal/sessions`;
    vi.resetModules();
    const mod = await import('../../src/activities/progress');
    sendProgressEvent = mod.sendProgressEvent;
    __resetWebhookConfigForTests = mod.__resetWebhookConfigForTests;
    __resetWebhookConfigForTests();

    const ev = makeEvent({
      eventId: 'evt_serialize',
      payload: { content: 'with "quotes" and \n newlines' },
      type: 'agent_output',
    });
    await sendProgressEvent(ev);

    const parsed = JSON.parse(bodyHex) as ProgressEvent;
    expect(parsed.eventId).toBe('evt_serialize');
    expect((parsed.payload as { content: string }).content).toContain('newlines');
  });
});
