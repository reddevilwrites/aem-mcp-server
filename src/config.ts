import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function optionalNumber(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultValue : n;
}

function optionalBoolean(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val.trim().toLowerCase() !== 'false';
}

export type AemPlatform = 'aemaacs' | 'aem65' | 'aem65lts';
export type AemInstance = 'author' | 'publish';

function requiredPlatform(key: string): AemPlatform {
  const val = required(key).trim().toLowerCase();
  if (val === 'aemaacs' || val === 'aem65' || val === 'aem65lts') return val;
  throw new Error(`Invalid ${key} value "${val}". Allowed values: "aemaacs", "aem65", "aem65lts".`);
}

function optionalInstance(key: string, defaultValue: AemInstance): AemInstance {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const val = raw.trim().toLowerCase();
  if (val === 'author' || val === 'publish') return val;
  throw new Error(`Invalid ${key} value "${val}". Allowed values: "author", "publish".`);
}

export const config = {
  aem: {
    host: optional('AEM_HOST', 'http://localhost:4502').replace(/\/$/, ''),
    username: optional('AEM_USERNAME', 'admin'),
    password: optional('AEM_PASSWORD', 'admin'),
    platform: requiredPlatform('AEM_PLATFORM'),
    instance: optionalInstance('AEM_INSTANCE', 'author'),
    contentRoot: optional('AEM_CONTENT_ROOT', '/content'),
    damRoot: optional('AEM_DAM_ROOT', '/content/dam'),
  },
  query: {
    asyncThreshold: optionalNumber('AEM_QUERY_ASYNC_THRESHOLD', 500),
    pageSize: optionalNumber('AEM_QUERY_PAGE_SIZE', 200),
    batchDelayMs: optionalNumber('AEM_BATCH_DELAY_MS', 200),
  },
  jobs: {
    ttlMs: optionalNumber('AEM_JOB_TTL_MS', 3_600_000),
    healthPollIntervalMs: optionalNumber('AEM_JOB_HEALTH_POLL_INTERVAL_MS', 15_000),
    healthRetryAfterMs: optionalNumber('AEM_JOB_HEALTH_RETRY_AFTER_MS', 30_000),
    degradedLatencyMs: optionalNumber('AEM_JOB_HEALTH_DEGRADED_LATENCY_MS', 1_500),
    criticalLatencyMs: optionalNumber('AEM_JOB_HEALTH_CRITICAL_LATENCY_MS', 4_000),
    maxHeapPercent: optionalNumber('AEM_JOB_HEALTH_MAX_HEAP_PERCENT', 85),
    maxQueuedJobs: optionalNumber('AEM_JOB_HEALTH_MAX_QUEUED_JOBS', 100),
    maxActiveJobs: optionalNumber('AEM_JOB_HEALTH_MAX_ACTIVE_JOBS', 20),
    maxFailedJobs: optionalNumber('AEM_JOB_HEALTH_MAX_FAILED_JOBS', 10),
    observabilityEnabled: optionalBoolean('AEM_JOB_OBSERVABILITY_ENABLED', true),
    observabilityEventsLimit: optionalNumber('AEM_JOB_OBSERVABILITY_EVENTS_LIMIT', 500),
  },
  debug: {
    enabled: process.env['DEBUG'] === 'true',
    verbose: process.env['DEBUG_VERBOSE'] === 'true',
  },
} as const;

/** Basic auth header value */
export function basicAuth(): string {
  return `Basic ${Buffer.from(`${config.aem.username}:${config.aem.password}`).toString('base64')}`;
}
