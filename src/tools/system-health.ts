import { aemClient, AemError } from '../aem-client.js';
import { config, AemPlatform } from '../config.js';
import { logger } from '../utils/logger.js';

interface GraniteHealthResult {
  name: string;
  status: 'OK' | 'WARN' | 'CRITICAL';
  notes?: string[];
}

interface JmxGcBean {
  objectName: string;
  attributes: {
    Name?: string;
    CollectionCount?: number;
    CollectionTime?: number;
  };
}

interface JmxMemoryBean {
  objectName: string;
  attributes: {
    HeapMemoryUsage?: { used?: number; max?: number; committed?: number };
    NonHeapMemoryUsage?: { used?: number; max?: number };
  };
}

interface SlingJobsStatusResponse {
  statistics?: {
    numberOfQueuedJobs?: number;
    numberOfActiveJobs?: number;
    numberOfJobs?: number;
    numberOfFinishedJobs?: number;
    numberOfFailedJobs?: number;
    numberOfCancelledJobs?: number;
  };
}

interface RawProbeResponse {
  status: number;
  text(): Promise<string>;
}

export interface SystemHealthResult {
  platform: string;
  timestamp: string;
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';
  graniteHealthChecks: GraniteHealthResult[];
  healthSources?: string[];
  authorProbe?: {
    endpoint: string;
    latencyMs: number;
    httpStatus: number;
    concern?: string;
  };
  slingJobs?: {
    queued: number;
    active: number;
    finished: number;
    failed: number;
    cancelled: number;
  };
  jvmMemory?: {
    heapUsedMb: number;
    heapMaxMb: number;
    heapUsedPercent: number;
    nonHeapUsedMb: number;
  };
  garbageCollectors?: Array<{
    name: string;
    collectionCount: number;
    collectionTimeMs: number;
    avgPauseMs: number;
    concern?: string;
  }>;
  errorLogSummary?: {
    recentErrors: string[];
    errorCount: number;
    warnCount: number;
  };
  replicationStatus?: {
    note: string;
  };
  jobSafety?: {
    action: 'continue' | 'pause';
    reason: string;
    retryAfterMs: number;
  };
  recommendations: string[];
  saasCaveat?: string;
}

export interface RuntimeHealthDecision {
  action: 'continue' | 'pause';
  reason: string;
  retryAfterMs: number;
  snapshot: SystemHealthResult;
}

type HealthCollectionMode = 'summary' | 'guard';

/**
 * System health check — dual-path implementation.
 *
 * AEMaaCS:
 *  - Uses author responsiveness probes and any directly accessible runtime status endpoints.
 *  - Official deep runtime inspection in AEMaaCS is via Developer Console status dumps/queries
 *    and Adobe-managed monitoring, not /system/health.
 *
 * AEM 6.5 / AMS / local SDK:
 *  - Uses author responsiveness probes, Sling Jobs status, JMX memory/GC, and error log tail.
 */
export async function systemHealthCheck(input: { platform?: string } = {}): Promise<SystemHealthResult> {
  return collectSystemHealth(input.platform, 'summary');
}

export async function assessLongRunningJobHealth(): Promise<RuntimeHealthDecision> {
  const snapshot = await collectSystemHealth(undefined, 'guard');
  return {
    action: snapshot.jobSafety?.action ?? 'continue',
    reason: snapshot.jobSafety?.reason ?? 'No runtime pressure detected.',
    retryAfterMs: snapshot.jobSafety?.retryAfterMs ?? config.jobs.healthRetryAfterMs,
    snapshot,
  };
}

async function collectSystemHealth(
  requestedPlatform?: string,
  mode: HealthCollectionMode = 'summary',
): Promise<SystemHealthResult> {
  const platform = await resolvePlatform(requestedPlatform);
  const timestamp = new Date().toISOString();
  const recommendations: string[] = [];
  const healthSources: string[] = [];
  const graniteHealthChecks: GraniteHealthResult[] = [];

  const base: SystemHealthResult = {
    platform,
    timestamp,
    overallStatus: 'UNKNOWN',
    graniteHealthChecks,
    healthSources,
    recommendations,
  };

  const authorProbe = await probeAuthorResponsiveness();
  if (authorProbe) {
    base.authorProbe = authorProbe;
    healthSources.push('author-probe');
    if (authorProbe.concern) recommendations.push(authorProbe.concern);
  } else {
    recommendations.push('CRITICAL: Could not complete author responsiveness probe.');
  }

  const slingJobs = await fetchSlingJobsStatus();
  if (slingJobs) {
    base.slingJobs = slingJobs;
    healthSources.push('status-slingjobs');
  } else if (platform === 'aemaacs') {
    recommendations.push(
      'AEMaaCS runtime Sling Jobs status is not directly accessible from this author endpoint or credential set. ' +
      'Use the AEM Developer Console status dumps for deeper runtime job-state analysis.',
    );
  }

  if (platform === 'aemaacs') {
    base.saasCaveat =
      'AEM as a Cloud Service does not expose direct JVM CPU, heap, or thread metrics on author through a stable /system/health endpoint. ' +
      'Use AEM Developer Console status dumps and Adobe-managed monitoring for deeper runtime inspection.';
    recommendations.push(base.saasCaveat);
    applyOverallStatus(base);
    base.jobSafety = evaluateJobSafety(base);
    base.overallStatus = deriveOverallStatus(base);
    return base;
  }

  const memory = await fetchJvmMemory();
  if (memory) {
    base.jvmMemory = memory;
    healthSources.push('jmx-memory');
    if (memory.heapUsedPercent >= config.jobs.maxHeapPercent) {
      recommendations.push(
        `WARN: Heap usage is ${memory.heapUsedPercent}% (${memory.heapUsedMb}MB / ${memory.heapMaxMb}MB). ` +
        'Long-running scans should back off until memory pressure improves.',
      );
    }
  }

  if (mode === 'summary') {
    const gcAnalysis = await fetchGcAnalysis();
    if (gcAnalysis) {
      base.garbageCollectors = gcAnalysis.collectors;
      healthSources.push('jmx-gc');
      recommendations.push(...gcAnalysis.concerns);
    }

    const logSummary = await fetchErrorLogSummary();
    if (logSummary) {
      base.errorLogSummary = logSummary;
      healthSources.push('error-log-tail');
      if (logSummary.errorCount > 50) {
        recommendations.push(
          `WARN: error.log contains ${logSummary.errorCount} ERROR lines in the last 500 lines. Review recent failures before running heavy scans.`,
        );
      }
    }
  }

  applyOverallStatus(base);
  base.jobSafety = evaluateJobSafety(base);
  base.overallStatus = deriveOverallStatus(base);

  if (base.recommendations.length === 0) {
    base.recommendations.push('No obvious runtime pressure or health issues detected.');
  }

  return base;
}

async function resolvePlatform(requestedPlatform?: string): Promise<'aemaacs' | 'aem65' | 'aem65lts'> {
  const explicit = requestedPlatform as AemPlatform | undefined;
  if (explicit === 'aemaacs' || explicit === 'aem65' || explicit === 'aem65lts') return explicit;
  return config.aem.platform;
}

async function probeAuthorResponsiveness(): Promise<SystemHealthResult['authorProbe'] | undefined> {
  const endpoint = '/libs/granite/core/content/login.html';
  const started = Date.now();

  try {
    const response = await aemClient.fetch<RawProbeResponse>(endpoint, {
      raw: true,
      headers: { Accept: 'text/html' },
    });
    const latencyMs = Date.now() - started;

    let concern: string | undefined;
    if (latencyMs >= config.jobs.criticalLatencyMs) {
      concern =
        `CRITICAL: Author probe latency is ${latencyMs}ms at ${endpoint}. ` +
        'Avoid starting or continuing heavy background scans until author responsiveness improves.';
    } else if (latencyMs >= config.jobs.degradedLatencyMs) {
      concern =
        `WARN: Author probe latency is ${latencyMs}ms at ${endpoint}. ` +
        'Background jobs should slow down and checkpoint progress.';
    }

    return { endpoint, latencyMs, httpStatus: response.status, concern };
  } catch (e) {
    logger.warn('Author responsiveness probe failed', e);
    return {
      endpoint,
      latencyMs: Date.now() - started,
      httpStatus: e instanceof AemError ? e.statusCode : 0,
      concern:
        `CRITICAL: Author probe failed for ${endpoint}. ` +
        'The author tier may be unavailable or under severe pressure.',
    };
  }
}

async function fetchSlingJobsStatus(): Promise<SystemHealthResult['slingJobs'] | undefined> {
  try {
    const response = await aemClient.get<SlingJobsStatusResponse>('/system/console/status-slingjobs.json');
    const stats = response.statistics;
    if (!stats) return undefined;

    return {
      queued: stats.numberOfQueuedJobs ?? 0,
      active: stats.numberOfActiveJobs ?? 0,
      finished: stats.numberOfFinishedJobs ?? 0,
      failed: stats.numberOfFailedJobs ?? 0,
      cancelled: stats.numberOfCancelledJobs ?? 0,
    };
  } catch (e) {
    if (e instanceof AemError && (e.statusCode === 403 || e.statusCode === 404 || e.statusCode === 302)) {
      return undefined;
    }
    logger.warn('Could not fetch Sling Jobs status', e);
    return undefined;
  }
}

async function fetchJvmMemory(): Promise<SystemHealthResult['jvmMemory'] | undefined> {
  try {
    const memBean = await aemClient.get<JmxMemoryBean>(
      '/system/console/jmx/java.lang%3Atype%3DMemory.json',
    );
    const heap = memBean.attributes?.HeapMemoryUsage;
    const nonHeap = memBean.attributes?.NonHeapMemoryUsage;

    if (heap?.used === undefined || heap?.max === undefined || heap.max <= 0) {
      return undefined;
    }

    return {
      heapUsedMb: Math.round(heap.used / 1_048_576),
      heapMaxMb: Math.round(heap.max / 1_048_576),
      heapUsedPercent: Math.round((heap.used / heap.max) * 100),
      nonHeapUsedMb: Math.round((nonHeap?.used ?? 0) / 1_048_576),
    };
  } catch (e) {
    logger.warn('Could not fetch JMX memory bean', e);
    return undefined;
  }
}

async function fetchGcAnalysis(): Promise<{
  collectors: SystemHealthResult['garbageCollectors'];
  concerns: string[];
} | undefined> {
  try {
    const gcBeans = await fetchGcBeans();
    return analyseGc(gcBeans);
  } catch (e) {
    logger.warn('Could not fetch JMX GC beans', e);
    return undefined;
  }
}

async function fetchGcBeans(): Promise<JmxGcBean[]> {
  const raw = await aemClient.get<{ value: Array<{ objectName: string }> }>(
    '/system/console/jmx.json',
    { 'filter.objectname': 'java.lang:type=GarbageCollector,*' },
  );

  const beans: JmxGcBean[] = [];
  for (const entry of raw.value ?? []) {
    try {
      const bean = await aemClient.get<JmxGcBean>(
        `/system/console/jmx/${encodeURIComponent(entry.objectName)}.json`,
      );
      beans.push(bean);
    } catch {
      // Individual bean fetch failure is non-fatal
    }
  }
  return beans;
}

function analyseGc(beans: JmxGcBean[]): {
  collectors: SystemHealthResult['garbageCollectors'];
  concerns: string[];
} {
  const collectors: NonNullable<SystemHealthResult['garbageCollectors']> = [];
  const concerns: string[] = [];

  for (const bean of beans) {
    const attrs = bean.attributes ?? {};
    const name = attrs.Name ?? bean.objectName;
    const count = attrs.CollectionCount ?? 0;
    const timeMs = attrs.CollectionTime ?? 0;
    const avgPauseMs = count > 0 ? Math.round(timeMs / count) : 0;

    let concern: string | undefined;
    const isOldGen = /old|tenured|major/i.test(name);
    if (isOldGen && avgPauseMs > 1000) {
      concern =
        `WARN: GC "${name}" average pause is ${avgPauseMs}ms. ` +
        'This suggests GC pressure that can hurt author responsiveness.';
      concerns.push(concern);
    } else if (isOldGen && count > 100) {
      concern =
        `WARN: GC "${name}" has executed ${count} times. ` +
        'Frequent major GC can indicate memory pressure or a leak.';
      concerns.push(concern);
    }

    collectors.push({ name, collectionCount: count, collectionTimeMs: timeMs, avgPauseMs, concern });
  }

  return { collectors, concerns };
}

async function fetchErrorLogSummary(): Promise<NonNullable<SystemHealthResult['errorLogSummary']> | undefined> {
  try {
    const raw = await aemClient.get<string>('/system/console/slinglog/tailer.txt', {
      name: 'logs/error.log',
      tail: '500',
    });

    const lines = typeof raw === 'string' ? raw.split('\n') : [];
    const errorLines = lines.filter(l => / ERROR /.test(l));
    const warnLines = lines.filter(l => / WARN /.test(l));

    return {
      recentErrors: errorLines.slice(-10).map(l => l.trim()).filter(Boolean),
      errorCount: errorLines.length,
      warnCount: warnLines.length,
    };
  } catch (e) {
    logger.warn('Could not fetch error log tail', e);
    return undefined;
  }
}

function applyOverallStatus(result: SystemHealthResult): void {
  const status = deriveOverallStatus(result);
  result.overallStatus = status;
}

function deriveOverallStatus(result: SystemHealthResult): SystemHealthResult['overallStatus'] {
  if (result.authorProbe?.httpStatus === 0) return 'CRITICAL';
  if ((result.authorProbe?.latencyMs ?? 0) >= config.jobs.criticalLatencyMs) return 'CRITICAL';
  if ((result.jvmMemory?.heapUsedPercent ?? 0) >= 95) return 'CRITICAL';
  if ((result.slingJobs?.failed ?? 0) > config.jobs.maxFailedJobs) return 'CRITICAL';

  if ((result.authorProbe?.latencyMs ?? 0) >= config.jobs.degradedLatencyMs) return 'DEGRADED';
  if ((result.jvmMemory?.heapUsedPercent ?? 0) >= config.jobs.maxHeapPercent) return 'DEGRADED';
  if ((result.slingJobs?.queued ?? 0) > config.jobs.maxQueuedJobs) return 'DEGRADED';
  if ((result.slingJobs?.active ?? 0) > config.jobs.maxActiveJobs) return 'DEGRADED';

  return 'HEALTHY';
}

function evaluateJobSafety(result: SystemHealthResult): NonNullable<SystemHealthResult['jobSafety']> {
  const retryAfterMs = config.jobs.healthRetryAfterMs;

  if (result.authorProbe?.httpStatus === 0) {
    return {
      action: 'pause',
      reason: 'Author responsiveness probe failed. Pause background work and retry later.',
      retryAfterMs,
    };
  }

  if ((result.authorProbe?.latencyMs ?? 0) >= config.jobs.criticalLatencyMs) {
    return {
      action: 'pause',
      reason:
        `Author responsiveness is degraded (${result.authorProbe?.latencyMs}ms). ` +
        'Pause heavy scans to avoid adding pressure.',
      retryAfterMs,
    };
  }

  if ((result.jvmMemory?.heapUsedPercent ?? 0) >= config.jobs.maxHeapPercent) {
    return {
      action: 'pause',
      reason:
        `Heap usage is ${result.jvmMemory?.heapUsedPercent}%, above the configured safety threshold. ` +
        'Pause long-running work and resume after memory pressure improves.',
      retryAfterMs,
    };
  }

  if ((result.slingJobs?.queued ?? 0) > config.jobs.maxQueuedJobs) {
    return {
      action: 'pause',
      reason:
        `Sling Jobs queue depth is ${result.slingJobs?.queued}, above the safety threshold. ` +
        'Pause background work to avoid exhausting worker threads.',
      retryAfterMs,
    };
  }

  if ((result.slingJobs?.active ?? 0) > config.jobs.maxActiveJobs) {
    return {
      action: 'pause',
      reason:
        `Active Sling Jobs count is ${result.slingJobs?.active}, above the safety threshold. ` +
        'Pause background work to reduce contention.',
      retryAfterMs,
    };
  }

  if ((result.slingJobs?.failed ?? 0) > config.jobs.maxFailedJobs) {
    return {
      action: 'pause',
      reason:
        `Failed Sling Jobs count is ${result.slingJobs?.failed}, indicating runtime instability. ` +
        'Pause heavy scans until the environment stabilizes.',
      retryAfterMs,
    };
  }

  return {
    action: 'continue',
    reason: 'No runtime pressure threshold has been exceeded.',
    retryAfterMs,
  };
}
