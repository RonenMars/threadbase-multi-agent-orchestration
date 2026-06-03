// Tiny config helper so connection details live in one place.

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  // Temporal
  address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'agent-tasks',

  // Anthropic
  model: process.env.AGENT_MODEL ?? 'claude-opus-4-7',

  // Progress webhook (worker → tb-streamer)
  progressWebhookUrl: process.env.PROGRESS_WEBHOOK_URL ?? 'http://localhost:3456/internal/sessions',
  progressHmacSecret: process.env.PROGRESS_HMAC_SECRET ?? 'dev-secret-change-me',
  webhookAttempts: Number(process.env.PROGRESS_WEBHOOK_ATTEMPTS ?? 3),
  webhookFirstDelayMs: Number(process.env.PROGRESS_WEBHOOK_FIRST_DELAY_MS ?? 200),
  webhookBackoffMultiplier: Number(process.env.PROGRESS_WEBHOOK_BACKOFF ?? 4),
  webhookTimeoutMs: Number(process.env.PROGRESS_WEBHOOK_TIMEOUT_MS ?? 2_000),
} as const;

// Forces a runtime check if any caller wants strict mode later. Unused for now
// since defaults are dev-safe; kept exported so the smoke scripts can opt in.
export function assertProductionConfig(): void {
  if (config.progressHmacSecret === 'dev-secret-change-me') {
    throw new Error('PROGRESS_HMAC_SECRET is the dev default; set it before running outside dev.');
  }
  required('ANTHROPIC_API_KEY');
}
