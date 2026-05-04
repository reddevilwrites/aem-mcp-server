#!/usr/bin/env node
/**
 * AEM MCP Server
 *
 * Capabilities:
 *  1.  aem_component_usage       — Pages using a specific component (AEMaaCS + 6.5/AMS)
 *  2.  aem_system_health         — System health check; dual-path (AEMaaCS: author probe + accessible runtime status, 6.5/AMS: + JMX/GC)
 *  3.  aem_workflow_audit        — Detect stale/failed workflow instances (AEMaaCS + 6.5/AMS)
 *  4.  aem_broken_link_scan      — Find broken internal links across pages (AEMaaCS + 6.5/AMS)
 *  5.  aem_orphaned_assets       — Find DAM assets unreferenced by any page (AEMaaCS + 6.5/AMS)
 *  6.  aem_msm_livecopy_status   — MSM live copy sync status (AEMaaCS + 6.5/AMS)
 *  7.  aem_audit_log             — Query Granite audit log (AEMaaCS + 6.5/AMS)
 *  8.  aem_permission_audit      — Read ACL/permissions for a JCR path (AEMaaCS + 6.5/AMS)
 *  9.  aem_clientlib_analysis    — Clientlib dependency/duplicate/circular analysis (AEMaaCS + 6.5/AMS)
 *  10. aem_page_property_report  — Report pages by JCR property; MSM-aware (AEMaaCS + 6.5/AMS)
 *  11. aem_replication_queue     — Replication agent queue diagnostics (⚠️  AEM 6.5 / AMS ONLY)
 *  12. aem_job_status            — Check status of a long-running async job
 *  13. aem_job_observability     — Inspect read-only async job telemetry
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './utils/logger.js';
import { jobManager } from './job-manager.js';
import { jobTelemetry } from './job-telemetry.js';
import { startHttpServer } from './http-server.js';

// Tool implementations
import { componentUsage } from './tools/component-usage.js';
import { systemHealthCheck } from './tools/system-health.js';
import { workflowAudit } from './tools/workflow-audit.js';
import { brokenLinkScan } from './tools/broken-links.js';
import { orphanedAssets } from './tools/orphaned-assets.js';
import { msmLiveCopyStatus } from './tools/msm-livecopy.js';
import { auditLogQuery } from './tools/audit-log.js';
import { permissionAudit } from './tools/permission-audit.js';
import { clientlibAnalysis } from './tools/clientlib-analysis.js';
import { pagePropertyReport } from './tools/page-property-report.js';
import { replicationQueueDiagnostics } from './tools/replication-queue.js';
import { assetExpiryReport, extendAssetExpiry } from './tools/asset-expiry.js';

// ─── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'aem_component_usage',
    description:
      'Find how many pages use a specific AEM component (by sling:resourceType) and list all those pages. ' +
      'Uses the slingResourceType Oak index — safe for large repositories. ' +
      'For large sites (>500 results), automatically dispatches an async job and returns a job ID. ' +
      'Compatible with AEM as a Cloud Service and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceType: {
          type: 'string',
          description: 'The sling:resourceType of the component, e.g. "mysite/components/hero" or "core/wcm/components/text/v2/text".',
        },
        searchPath: {
          type: 'string',
          description: 'JCR root path to search under. Defaults to AEM_CONTENT_ROOT (/content).',
        },
        async: {
          type: 'boolean',
          description: 'Force async execution. Useful when you already know the site is large.',
        },
      },
      required: ['resourceType'],
    },
  },

  {
    name: 'aem_system_health',
    description:
      'Analyse the current AEM system health and surface issues. ' +
      'AEM as a Cloud Service: Uses author responsiveness probes and any directly accessible runtime status endpoints, ' +
      'with a caveat that deeper runtime inspection in AEMaaCS is via Developer Console status dumps and Adobe-managed monitoring. ' +
      'AEM 6.5 / AMS: Additionally reads JVM heap usage, GC pause statistics via JMX, Sling Jobs queue stats, and error log tail. ' +
      'Returns overall status (HEALTHY / DEGRADED / CRITICAL) with actionable recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['aemaacs', 'aem65', 'aem65lts'],
          description: 'Override the configured platform for this call. Allowed values: aemaacs, aem65, aem65lts.',
        },
      },
    },
  },

  {
    name: 'aem_workflow_audit',
    description:
      'Detect stale and failed workflow instances. ' +
      'A workflow instance is "stale" if it has been RUNNING beyond a configurable threshold. ' +
      'Large workflow stores (>500 instances) are processed as async jobs. ' +
      'Compatible with AEM as a Cloud Service and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        staleThresholdHours: {
          type: 'number',
          description: 'Hours after which a RUNNING workflow instance is considered stale. Default: 24.',
        },
        modelPath: {
          type: 'string',
          description: 'Optional: filter to a specific workflow model path, e.g. /var/workflow/models/dam/update_asset.',
        },
        includeFailed: {
          type: 'boolean',
          description: 'Include FAILED instances in addition to stale RUNNING ones. Default: true.',
        },
        async: { type: 'boolean' },
      },
    },
  },

  {
    name: 'aem_broken_link_scan',
    description:
      'Scan all pages under a root path for broken internal links. ' +
      'Checks properties like linkURL, fileReference, ctaLink, redirect, etc. ' +
      'ALWAYS runs as an async job — returns a job ID immediately. Use aem_job_status to retrieve results. ' +
      'Compatible with AEM as a Cloud Service and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: {
          type: 'string',
          description: 'JCR root path to scan, e.g. /content/mysite/en.',
        },
        linkProperties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional property names to check for internal links. Default set covers common AEM properties.',
        },
        maxPages: {
          type: 'number',
          description: 'Maximum number of pages to scan. Default: 2000.',
        },
      },
      required: ['rootPath'],
    },
  },

  {
    name: 'aem_orphaned_assets',
    description:
      'Find DAM assets that are not referenced by any page. ' +
      'Two-pass approach: first collects all asset references from pages, then diffs against all assets in the DAM path. ' +
      'ALWAYS runs as an async job — returns a job ID immediately. Use aem_job_status to retrieve results. ' +
      'Note: references from Experience Fragments, Content Fragments, or external systems are not included. ' +
      'Compatible with AEM as a Cloud Service and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        damPath: {
          type: 'string',
          description: 'DAM root path to scan for orphaned assets. Defaults to AEM_DAM_ROOT (/content/dam).',
        },
        contentPath: {
          type: 'string',
          description: 'Content root to scan for asset references. Defaults to AEM_CONTENT_ROOT (/content).',
        },
        maxAssets: {
          type: 'number',
          description: 'Maximum assets to evaluate. Default: 5000.',
        },
      },
    },
  },

  {
    name: 'aem_msm_livecopy_status',
    description:
      'Analyse MSM (Multi-Site Manager) live copy synchronisation status. ' +
      'Detects which live copies are out-of-sync with their language master, which have suspended inheritance, ' +
      'and which have individual property/child inheritance cancelled. ' +
      'Compatible with AEM as a Cloud Service and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: {
          type: 'string',
          description: 'Root path to scan for live copy configurations. Defaults to AEM_CONTENT_ROOT.',
        },
        outOfSyncOnly: {
          type: 'boolean',
          description: 'Only return live copies that are out of sync or suspended. Default: false.',
        },
        async: { type: 'boolean' },
      },
    },
  },

  {
    name: 'aem_audit_log',
    description:
      'Query the Granite Audit Log for recent content changes. ' +
      'Filter by resource path, user, date range, or event type (PageEvent, AssetEvent, ReplicationEvent, etc.). ' +
      'Supports relative date filters like "7d" (last 7 days), "24h", "30m". ' +
      'Compatible with AEM as a Cloud Service and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        resourcePath: {
          type: 'string',
          description: 'Filter events to a specific JCR path, e.g. /content/mysite/en.',
        },
        user: {
          type: 'string',
          description: 'Filter by AEM user login name.',
        },
        startDate: {
          type: 'string',
          description: 'Start date filter. ISO 8601 format or relative: "7d", "24h", "30m".',
        },
        endDate: {
          type: 'string',
          description: 'End date filter. ISO 8601 format or relative.',
        },
        eventType: {
          type: 'string',
          description: 'Event type filter, e.g. "PageEvent", "AssetEvent", "ReplicationEvent".',
        },
        limit: {
          type: 'number',
          description: 'Max events to return. Default: 200.',
        },
      },
    },
  },

  {
    name: 'aem_permission_audit',
    description:
      'Read and analyse ACL (Access Control Entries) for a JCR path. ' +
      'Reports which principals have allow/deny privileges, detects dangerous configurations ' +
      'like write access for the "everyone" group. ' +
      'Read-only — does not modify permissions. ' +
      'Compatible with AEM as a Cloud Service (read-only, requires service user access to rep:policy) and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'JCR path to audit, e.g. /content/mysite/en.',
        },
        principals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: filter to specific principal names (users or groups).',
        },
        depth: {
          type: 'number',
          description: 'Depth to scan child pages for their own ACEs. Default: 1 (only the given path).',
        },
      },
      required: ['path'],
    },
  },

  {
    name: 'aem_clientlib_analysis',
    description:
      'Analyse AEM Client Libraries (cq:ClientLibraryFolder). ' +
      'Detects duplicate category names, circular dependency chains, and overly large embeds. ' +
      'Uses the nodetype Oak index — safe for all repository sizes. ' +
      'Compatible with AEM as a Cloud Service and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: {
          type: 'string',
          description: 'Root path to scan. Default: /apps. Avoid /libs unless necessary — very large.',
        },
        channel: {
          type: 'string',
          enum: ['publish', 'author'],
          description: 'Filter by channel. Leave empty for all.',
        },
        async: { type: 'boolean' },
      },
    },
  },

  {
    name: 'aem_page_property_report',
    description:
      'Generate a report of pages that have (or are missing) a specific JCR property. ' +
      'MSM-aware: when MSM live copies are detected, defaults to scanning the language master path. ' +
      'To report on a live copy (e.g. US English), set rootPath="/content/mysite/us/en" and scope="livecopy". ' +
      'For well-known indexed properties (cq:template, jcr:title, etc.) uses fast QueryBuilder queries. ' +
      'For custom/non-indexed properties, pages are fetched and checked in batches to avoid traversal. ' +
      'Compatible with AEM as a Cloud Service and AEM 6.5/AMS.',
    inputSchema: {
      type: 'object',
      properties: {
        property: {
          type: 'string',
          description: 'JCR property name on jcr:content (e.g. "cq:template", "jcr:title", "hideInNav", "sling:vanityPath", "myCustomProp").',
        },
        propertyValue: {
          type: 'string',
          description: 'Optional: value filter. For analyzed text properties like jcr:title, this works as a term/contains search. Example: property="jcr:title", propertyValue="WKND" matches "WKND Adventure". For non-text properties, matching remains exact.',
        },
        reportMissing: {
          type: 'boolean',
          description: 'If true, return pages where the property is ABSENT. Default: false.',
        },
        rootPath: {
          type: 'string',
          description: 'Root path to search. MSM master path is used by default when MSM is detected.',
        },
        scope: {
          type: 'string',
          enum: ['master', 'livecopy', 'all'],
          description: '"master" = language master only, "livecopy" = rootPath as live copy, "all" = full rootPath. Default: all.',
        },
        maxPages: {
          type: 'number',
          description: 'Maximum pages to scan. Default: 5000.',
        },
        async: { type: 'boolean' },
      },
      required: ['property'],
    },
  },

  {
    name: 'aem_replication_queue',
    description:
      '⚠️  AEM 6.5 / AMS ONLY — NOT available in AEM as a Cloud Service. ' +
      'In AEMaaCS, publishing uses an internal Sling Content Distribution mechanism and has no replication agents. ' +
      'For AEM 6.5/AMS: checks replication agent status, queue depth, blocked agents, and failed queue items. ' +
      'Identifies agents that are disabled, blocked, or accumulating a backlog.',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          enum: ['author', 'preview', 'all'],
          description: 'Which agent set to check. Default: all.',
        },
        includeQueueItems: {
          type: 'boolean',
          description: 'Include the first 50 items from each non-empty queue. Default: true.',
        },
      },
    },
  },

  {
    name: 'aem_asset_expiry_report',
    description:
      'Find DAM assets whose offTime (expiry) falls within the next N days. ' +
      'offTime lives on the asset jcr:content node and drives AEM activation windows. ' +
      'Returns up to 10 soonest-expiring assets plus the total count when more exist. ' +
      'AUTHOR INSTANCE ONLY — refuses to run when AEM_INSTANCE=publish. ' +
      'Compatible with AEM as a Cloud Service (author tier) and AEM 6.5/AMS author.',
    inputSchema: {
      type: 'object',
      properties: {
        withinDays: {
          type: 'number',
          description: 'Find assets expiring within the next N days. E.g. 5 = "expiring in the next 5 days".',
        },
        damPath: {
          type: 'string',
          description: 'DAM root to scan. Defaults to AEM_DAM_ROOT (/content/dam).',
        },
        includeExpired: {
          type: 'boolean',
          description: 'Include assets whose offTime is already in the past. Default: false.',
        },
        maxAssets: {
          type: 'number',
          description: 'Hard cap on assets evaluated. Default: 5000.',
        },
      },
      required: ['withinDays'],
    },
  },

  {
    name: 'aem_extend_asset_expiry',
    description:
      'Update the activation window (onTime / offTime) of one or more DAM assets, ' +
      'and optionally publish them to the publish tier. ' +
      'Target assets either via `assetPaths` (explicit list) or `withinDays` (every ' +
      'asset under damPath whose offTime falls within that window). ' +
      'Mutations: `extendByDays` (add to current offTime; falls back to "now" when the ' +
      'asset has no existing offTime), `newOffTime` (absolute go-down/expiry date), and/or ' +
      '`newOnTime` (absolute go-live date — works even on assets with no current onTime/offTime). ' +
      'Set `publish: true` to replicate updated assets to the publish tier in a second ' +
      'batched phase — failures are reported back per asset in `failedReplicationPaths`. ' +
      'IMPORTANT: BEFORE setting publish=true, the calling agent MUST ask the user for ' +
      'explicit consent (publishing makes the change visible to publish consumers). ' +
      'Updates and replication run in batches with a delay between batches; dispatches as ' +
      'an async job above the configured threshold so system performance is not impacted. ' +
      'Use `dryRun` to preview without writing or publishing. ' +
      'AUTHOR INSTANCE ONLY. Compatible with AEMaaCS author tier and AEM 6.5/AMS author.',
    inputSchema: {
      type: 'object',
      properties: {
        assetPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit list of asset paths. Mutually exclusive with withinDays.',
        },
        withinDays: {
          type: 'number',
          description: 'Apply to every asset under damPath whose offTime falls within N days. Mutually exclusive with assetPaths.',
        },
        damPath: {
          type: 'string',
          description: 'DAM root used when filtering by withinDays. Defaults to AEM_DAM_ROOT.',
        },
        extendByDays: {
          type: 'number',
          description: 'Add this many days to the asset\'s current offTime (falls back to "now" if no offTime is set). Mutually exclusive with newOffTime.',
        },
        newOffTime: {
          type: 'string',
          description: 'Absolute new offTime in ISO 8601, e.g. "2026-12-31T23:59:59Z". Mutually exclusive with extendByDays.',
        },
        newOnTime: {
          type: 'string',
          description: 'Absolute go-live date (onTime) in ISO 8601, e.g. "2026-05-20T00:00:00Z". Independent of the offTime fields — can be set on assets that have never had an activation window.',
        },
        publish: {
          type: 'boolean',
          description: 'After successful property updates, replicate the assets to the publish tier (Sling Activate). REQUIRES explicit user consent — the calling agent must ask the user before setting this to true. Default: false.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview the changes without writing or publishing. Default: false.',
        },
        batchSize: {
          type: 'number',
          description: 'Number of asset updates / replications per batch. Default: 25.',
        },
        maxAssets: {
          type: 'number',
          description: 'Cap when withinDays is used. Default: 5000.',
        },
        async: { type: 'boolean' },
      },
    },
  },

  {
    name: 'aem_job_status',
    description:
      'Check the status of a long-running async AEM job. ' +
      'Several tools (broken link scan, orphaned assets, large component usage queries, etc.) ' +
      'return a job ID instead of waiting for results. Use this tool with that job ID to retrieve results.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The job ID returned by the async tool call.',
        },
      },
      required: ['jobId'],
    },
  },

  {
    name: 'aem_job_observability',
    description:
      'Read diagnostic telemetry for async MCP jobs. Use this to confirm async dispatch, ' +
      'heartbeats, checkpoint saves, health-based pause/resume, completion, failure, and cleanup. ' +
      'This is read-only and does not expose checkpoint payload contents, AEM credentials, request bodies, or page/asset data.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Optional job ID to inspect.',
        },
        toolName: {
          type: 'string',
          description: 'Optional tool name filter, e.g. aem_broken_link_scan.',
        },
        includeEvents: {
          type: 'boolean',
          description: 'Include recent structured lifecycle events. Default: false.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of recent events to return when includeEvents=true. Capped by AEM_JOB_OBSERVABILITY_EVENTS_LIMIT.',
        },
      },
    },
  },
];

// ─── Server setup ──────────────────────────────────────────────────────────────

/**
 * Build a fresh MCP Server instance with all tools registered.
 *
 * The MCP SDK's `Server.connect()` can only attach to one transport per
 * instance — so for the multi-session HTTP transport we MUST create a new
 * Server per session. Tool definitions and dispatch logic are stateless, so
 * spinning up a new Server is cheap (no AEM call, just handler registration).
 *
 * Stateful objects (jobManager, aemClient) remain process-wide singletons —
 * jobs and AEM connections are correctly shared across sessions.
 */
export function createMcpServer(): Server {
  const server = new Server(
    { name: 'aem-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    logger.info(`Tool called: ${name}`);

    try {
      const result = await dispatch(name, args as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Tool error: ${name}`, error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Dispatch ──────────────────────────────────────────────────────────────────

async function dispatch(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'aem_component_usage':
      return componentUsage({
        resourceType: String(args['resourceType'] ?? ''),
        searchPath: args['searchPath'] ? String(args['searchPath']) : undefined,
        async: Boolean(args['async']),
      });

    case 'aem_system_health':
      return systemHealthCheck({
        platform: args['platform'] ? String(args['platform']) : undefined,
      });

    case 'aem_workflow_audit':
      return workflowAudit({
        staleThresholdHours: args['staleThresholdHours'] ? Number(args['staleThresholdHours']) : 24,
        modelPath: args['modelPath'] ? String(args['modelPath']) : undefined,
        includeFailed: args['includeFailed'] !== false,
        async: Boolean(args['async']),
      });

    case 'aem_broken_link_scan':
      return brokenLinkScan({
        rootPath: String(args['rootPath'] ?? ''),
        linkProperties: Array.isArray(args['linkProperties'])
          ? (args['linkProperties'] as string[])
          : undefined,
        maxPages: args['maxPages'] ? Number(args['maxPages']) : undefined,
      });

    case 'aem_orphaned_assets':
      return orphanedAssets({
        damPath: args['damPath'] ? String(args['damPath']) : undefined,
        contentPath: args['contentPath'] ? String(args['contentPath']) : undefined,
        maxAssets: args['maxAssets'] ? Number(args['maxAssets']) : undefined,
      });

    case 'aem_msm_livecopy_status':
      return msmLiveCopyStatus({
        rootPath: args['rootPath'] ? String(args['rootPath']) : undefined,
        outOfSyncOnly: Boolean(args['outOfSyncOnly']),
        async: Boolean(args['async']),
      });

    case 'aem_audit_log':
      return auditLogQuery({
        resourcePath: args['resourcePath'] ? String(args['resourcePath']) : undefined,
        user: args['user'] ? String(args['user']) : undefined,
        startDate: args['startDate'] ? String(args['startDate']) : undefined,
        endDate: args['endDate'] ? String(args['endDate']) : undefined,
        eventType: args['eventType'] ? String(args['eventType']) : undefined,
        limit: args['limit'] ? Number(args['limit']) : 200,
        async: Boolean(args['async']),
      });

    case 'aem_permission_audit':
      return permissionAudit({
        path: String(args['path'] ?? ''),
        principals: Array.isArray(args['principals'])
          ? (args['principals'] as string[])
          : undefined,
        depth: args['depth'] ? Number(args['depth']) : 1,
      });

    case 'aem_clientlib_analysis':
      return clientlibAnalysis({
        rootPath: args['rootPath'] ? String(args['rootPath']) : undefined,
        channel: args['channel'] ? String(args['channel']) as 'publish' | 'author' : undefined,
        async: Boolean(args['async']),
      });

    case 'aem_page_property_report':
      return pagePropertyReport({
        property: String(args['property'] ?? ''),
        propertyValue: args['propertyValue'] ? String(args['propertyValue']) : undefined,
        reportMissing: Boolean(args['reportMissing']),
        rootPath: args['rootPath'] ? String(args['rootPath']) : undefined,
        scope: args['scope'] ? String(args['scope']) as 'master' | 'livecopy' | 'all' : 'all',
        maxPages: args['maxPages'] ? Number(args['maxPages']) : undefined,
        async: Boolean(args['async']),
      });

    case 'aem_replication_queue':
      return replicationQueueDiagnostics({
        agentType: args['agentType'] ? String(args['agentType']) as 'author' | 'preview' | 'all' : 'all',
        includeQueueItems: args['includeQueueItems'] !== false,
      });

    case 'aem_asset_expiry_report':
      return assetExpiryReport({
        withinDays: Number(args['withinDays'] ?? 0),
        damPath: args['damPath'] ? String(args['damPath']) : undefined,
        includeExpired: Boolean(args['includeExpired']),
        maxAssets: args['maxAssets'] ? Number(args['maxAssets']) : undefined,
      });

    case 'aem_extend_asset_expiry':
      return extendAssetExpiry({
        assetPaths: Array.isArray(args['assetPaths'])
          ? (args['assetPaths'] as string[])
          : undefined,
        withinDays: args['withinDays'] !== undefined ? Number(args['withinDays']) : undefined,
        damPath: args['damPath'] ? String(args['damPath']) : undefined,
        extendByDays: args['extendByDays'] !== undefined ? Number(args['extendByDays']) : undefined,
        newOffTime: args['newOffTime'] ? String(args['newOffTime']) : undefined,
        newOnTime: args['newOnTime'] ? String(args['newOnTime']) : undefined,
        publish: Boolean(args['publish']),
        dryRun: Boolean(args['dryRun']),
        batchSize: args['batchSize'] ? Number(args['batchSize']) : undefined,
        maxAssets: args['maxAssets'] ? Number(args['maxAssets']) : undefined,
        async: Boolean(args['async']),
      });

    case 'aem_job_status':
      return jobManager.getStatus(String(args['jobId'] ?? ''));

    case 'aem_job_observability':
      return jobTelemetry.snapshot({
        jobId: args['jobId'] ? String(args['jobId']) : undefined,
        toolName: args['toolName'] ? String(args['toolName']) : undefined,
        includeEvents: Boolean(args['includeEvents']),
        limit: args['limit'] ? Number(args['limit']) : undefined,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────────

interface CliOptions {
  http: boolean;
  port: number;
}

function parseCli(argv: readonly string[]): CliOptions {
  const http = argv.includes('--http');
  const portArg = argv.find((a) => a.startsWith('--port='));
  const portFromArg = portArg ? Number(portArg.slice('--port='.length)) : undefined;
  const portFromEnv = process.env['PORT'] ? Number(process.env['PORT']) : undefined;
  const port = portFromArg ?? portFromEnv ?? 3000;
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    throw new Error(`Invalid port "${portArg ?? process.env['PORT']}".`);
  }
  return { http, port };
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));

  if (opts.http) {
    const authToken = process.env['MCP_AUTH_TOKEN'];
    if (!authToken || authToken.length < 16) {
      logger.error(
        'MCP_AUTH_TOKEN must be set (>= 16 chars) when --http is used. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomUUID())"',
      );
      process.exit(1);
    }
    const handle = await startHttpServer(createMcpServer, { port: opts.port, authToken });

    // Signal handlers belong here, not inside startHttpServer — registering
    // them in the entry-point keeps the module idempotent (tests can call
    // startHttpServer repeatedly without stacking listeners).
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Received ${signal}, shutting down…`);
      try {
        await handle.close();
      } catch (e) {
        logger.error('Error during shutdown', e);
      }
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
    return;
  }

  // stdio: single, long-lived connection → one Server instance is fine.
  const stdioServer = createMcpServer();
  const transport = new StdioServerTransport();
  await stdioServer.connect(transport);
  logger.info('AEM MCP Server started — listening on stdio');
}

main().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
