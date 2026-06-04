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
import { Context } from '@temporalio/activity';
import type { Logger } from '@temporalio/common';
import { config } from '../shared/config';
import { logger as rootLogger } from '../shared/logger';

/**
 * Get the activity-context logger when running inside Temporal, or fall back
 * to the root pino logger when called outside an activity (unit tests, smoke
 * scripts). The shapes are compatible — both accept `(meta, message)`.
 */
function getLogger(): Logger {
  try {
    return Context.current().log;
  } catch {
    // Not inside an activity context — use the root pino logger directly.
    // Pino satisfies the Temporal Logger shape (via pinoToTemporalLogger
    // pattern), so we return a thin shim.
    return {
      trace: (msg, meta) => (meta ? rootLogger.trace(meta, msg) : rootLogger.trace(msg)),
      debug: (msg, meta) => (meta ? rootLogger.debug(meta, msg) : rootLogger.debug(msg)),
      info: (msg, meta) => (meta ? rootLogger.info(meta, msg) : rootLogger.info(msg)),
      warn: (msg, meta) => (meta ? rootLogger.warn(meta, msg) : rootLogger.warn(msg)),
      error: (msg, meta) => (meta ? rootLogger.error(meta, msg) : rootLogger.error(msg)),
      log: (level, msg, meta) => {
        const fn = (rootLogger as unknown as Record<string, (m: unknown, s?: string) => void>)[
          level.toLowerCase()
        ];
        if (fn) {
          if (meta) fn(meta, msg);
          else fn(msg);
        } else {
          rootLogger.info({ level }, msg);
        }
      },
    } as Logger;
  }
}

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
  const log = getLogger();
  const baseMeta = {
    eventId: ev.eventId,
    sessionId: ev.sessionId,
    turnId: ev.turnId,
    type: ev.type,
    stage: ev.stage,
  };
  let delay = cfg.firstDelayMs;

  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    try {
      const { ok, status } = await postOnce(cfg, ev);
      if (ok) {
        log.debug('progress webhook ok', { ...baseMeta, attempt, status });
        return;
      }
      // 4xx (e.g. 401 from bad HMAC, 404 unknown session) is a config error,
      // not transient — log and stop.
      if (status >= 400 && status < 500) {
        log.warn('progress webhook non-retryable; giving up', { ...baseMeta, attempt, status });
        return;
      }
      // 5xx — fall through to retry.
      log.warn('progress webhook 5xx, will retry', {
        ...baseMeta,
        attempt,
        status,
        attemptsRemaining: cfg.attempts - attempt,
      });
    } catch (err) {
      // Transport error (timeout, ECONNREFUSED, etc.). Treat as retryable.
      log.warn('progress webhook transport error, will retry', {
        ...baseMeta,
        attempt,
        attemptsRemaining: cfg.attempts - attempt,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    if (attempt < cfg.attempts) {
      await sleep(delay);
      delay = delay * cfg.backoff;
    }
  }
  // All attempts spent. Log and return — never throw.
  log.warn('progress webhook gave up', { ...baseMeta, attempts: cfg.attempts });
}
