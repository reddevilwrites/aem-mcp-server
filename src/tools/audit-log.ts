import { aemClient } from '../aem-client.js';
import { jobManager, JobExecutionContext, JobStartResult } from '../job-manager.js';
import { logger } from '../utils/logger.js';

export interface AuditLogInput {
  /** JCR path to filter events by (e.g. /content/mysite/en) */
  resourcePath?: string;
  /** Filter by AEM user login */
  user?: string;
  /** ISO date string or relative like "7d", "24h" */
  startDate?: string;
  endDate?: string;
  /**
   * Event type filter. Common values:
   *  - "PageEvent" (cq/gui/components/authoring/page)
   *  - "AssetEvent" (dam/gui/components/admin/asset)
   *  - "ReplicationEvent"
   *  - "WorkflowEvent"
   * Leave empty for all types.
   */
  eventType?: string;
  /** Max events to return (default: 200) */
  limit?: number;
  async?: boolean;
}

export interface AuditEvent {
  path: string;
  userId: string;
  type: string;
  category: string;
  time: string;
  description?: string;
  userData?: Record<string, string>;
}

export interface AuditLogResult {
  eventCount: number;
  events: AuditEvent[];
  filters: Record<string, string>;
  note: string;
}

/**
 * Query the Granite Audit Log.
 *
 * Compatible with AEMaaCS and AEM 6.5/AMS.
 * Endpoint: GET /libs/granite/audit/gui/content/events.json
 */
export async function auditLogQuery(
  input: AuditLogInput = {},
): Promise<AuditLogResult | JobStartResult> {
  const {
    resourcePath,
    user,
    startDate,
    endDate,
    eventType,
    limit = 200,
    async: forceAsync = false,
  } = input;

  if (forceAsync) {
    return jobManager.start(
      'aem_audit_log',
      input as Record<string, unknown>,
      (ctx) => runAuditQuery(resourcePath, user, startDate, endDate, eventType, limit, ctx),
      15_000,
    );
  }

  return runAuditQuery(resourcePath, user, startDate, endDate, eventType, limit);
}

async function runAuditQuery(
  resourcePath: string | undefined,
  user: string | undefined,
  startDate: string | undefined,
  endDate: string | undefined,
  eventType: string | undefined,
  limit: number,
  ctx?: JobExecutionContext,
): Promise<AuditLogResult> {
  await ctx?.heartbeat({
    progressPercent: 10,
    message: 'Querying Granite audit log events.',
    force: true,
  });

  const params: Record<string, string> = {
    '_charset_': 'UTF-8',
    'p.limit': String(limit),
    'p.offset': '0',
  };

  if (resourcePath) params['s.path'] = resourcePath;
  if (user) params['s.userId'] = user;
  if (eventType) params['s.type'] = eventType;

  // Date parsing: support ISO strings and relative shortcuts
  if (startDate) {
    const resolved = resolveDate(startDate);
    if (resolved) params['s.from'] = resolved;
  }
  if (endDate) {
    const resolved = resolveDate(endDate);
    if (resolved) params['s.to'] = resolved;
  }

  interface RawAuditResponse {
    results?: Array<Record<string, unknown>>;
    total?: number;
  }

  let raw: RawAuditResponse = { results: [] };
  try {
    raw = await aemClient.get<RawAuditResponse>(
      '/libs/granite/audit/gui/content/events.json',
      params as Record<string, string | number | boolean>,
    );
  } catch (e) {
    logger.warn('Audit log endpoint error', e);
    return {
      eventCount: 0,
      events: [],
      filters: params,
      note: 'Could not reach the Granite audit log endpoint. Verify the user has read access to /var/audit.',
    };
  }

  const events: AuditEvent[] = (raw.results ?? []).map(mapEvent);

  return {
    eventCount: events.length,
    events,
    filters: params,
    note:
      'Audit log results depend on AEM audit log retention settings. ' +
      'By default AEM retains 7 days of audit log data. ' +
      'Results are ordered by most recent first.',
  };
}

function mapEvent(raw: Record<string, unknown>): AuditEvent {
  return {
    path: String(raw['path'] ?? raw['s.path'] ?? ''),
    userId: String(raw['userId'] ?? raw['user'] ?? ''),
    type: String(raw['type'] ?? ''),
    category: String(raw['category'] ?? ''),
    time: raw['time']
      ? new Date(Number(raw['time'])).toISOString()
      : String(raw['date'] ?? ''),
    description: raw['description'] ? String(raw['description']) : undefined,
    userData: raw['userData'] as Record<string, string> | undefined,
  };
}

/**
 * Resolve a date string.
 * Supports ISO format (returned as-is) and relative shortcuts like "7d", "24h", "30m".
 */
function resolveDate(value: string): string | null {
  // Already an ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;

  const match = value.match(/^(\d+)(d|h|m)$/);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === 'd' ? amount * 86_400_000
    : unit === 'h' ? amount * 3_600_000
    : amount * 60_000;

  return new Date(Date.now() - ms).toISOString();
}
