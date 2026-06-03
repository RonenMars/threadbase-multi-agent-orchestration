// src/activities/progress.ts
//
// Fire-and-forget HMAC-signed webhook from worker activities to tb-streamer.
//
// Semantics (spec §7.3):
// - Short transport retry window: a few attempts with light backoff.
// - NEVER throws. Webhook failure never fails the surrounding activity.
// - Worker activity retry policy is for LLM/business failures, not webhooks.

import crypto from 'node:crypto';
import type { ProgressEvent } from '@threadbase/agent-types';
import { config } from '../shared/config';

interface WebhookConfig {
  url: string;
  secret: string;
  attempts: number;
  firstDelayMs: number;
  backoff: number;
  timeoutMs: number;
}

let cached: WebhookConfig | undefined;

function readConfig(): WebhookConfig {
  if (cached) return cached;
  cached = {
    url: config.progressWebhookUrl,
    secret: config.progressHmacSecret,
    attempts: Math.max(1, config.webhookAttempts),
    firstDelayMs: Math.max(0, config.webhookFirstDelayMs),
    backoff: Math.max(1, config.webhookBackoffMultiplier),
    timeoutMs: Math.max(1, config.webhookTimeoutMs),
  };
  return cached;
}

/** Test hook — invalidate the cached config so test env vars re-read. */
export function __resetWebhookConfigForTests(): void {
  cached = undefined;
  // Also re-read `config` from env in tests by deleting require-cache for the
  // shared config module. The simpler path is to mutate the cached object;
  // since the smoke/test code mutates env BEFORE the first call, the cached
  // version is whatever was current then. Reset is sufficient.
}

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function postOnce(cfg: WebhookConfig, ev: ProgressEvent): Promise<{ ok: boolean; status: number }> {
  const body = JSON.stringify(ev);
  const signature = sign(body, cfg.secret);
  // Append sessionId to the URL per spec §5.1 — POST /internal/sessions/:sessionId/progress.
  const url = `${cfg.url.replace(/\/$/, '')}/${encodeURIComponent(ev.sessionId)}/progress`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-progress-signature': signature,
        'x-progress-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-progress-event-id': ev.eventId,
      },
      body,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Activity entry point. Best-effort POST with a short retry window.
 * Never throws — see spec §7.3 sub-decision 2.
 */
export async function sendProgressEvent(ev: ProgressEvent): Promise<void> {
  const cfg = readConfig();
  let delay = cfg.firstDelayMs;

  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    try {
      const { ok, status } = await postOnce(cfg, ev);
      if (ok) return;
      // 4xx (e.g. 401 from bad HMAC) is a config error, not transient — log and stop.
      if (status >= 400 && status < 500) {
        // eslint-disable-next-line no-console
        console.warn(`[progress] non-retryable ${status} for ${ev.eventId}; giving up`);
        return;
      }
      // 5xx — fall through to retry.
      // eslint-disable-next-line no-console
      console.warn(`[progress] attempt ${attempt}/${cfg.attempts} got ${status} for ${ev.eventId}`);
    } catch (err) {
      // Transport error (timeout, ECONNREFUSED, etc.). Treat as retryable.
      // eslint-disable-next-line no-console
      console.warn(`[progress] attempt ${attempt}/${cfg.attempts} threw for ${ev.eventId}:`, err);
    }

    if (attempt < cfg.attempts) {
      await sleep(delay);
      delay = delay * cfg.backoff;
    }
  }
  // All attempts spent. Log and return — never throw.
  // eslint-disable-next-line no-console
  console.warn(`[progress] gave up after ${cfg.attempts} attempts for ${ev.eventId}`);
}
