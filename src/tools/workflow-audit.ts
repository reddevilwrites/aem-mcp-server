import { queryBuilder } from '../query-builder.js';
import { jobManager, JobStartResult } from '../job-manager.js';
import { config } from '../config.js';

export interface WorkflowAuditInput {
  /** Min age in hours before a RUNNING instance is considered stale (default: 24) */
  staleThresholdHours?: number;
  /** Filter by workflow model path, e.g. /var/workflow/models/dam/update_asset */
  modelPath?: string;
  /** Include FAILED instances in addition to stale RUNNING ones */
  includeFailed?: boolean;
  async?: boolean;
}

interface WorkflowInstance {
  path: string;
  model: string;
  status: string;
  startTime?: string;
  initiator?: string;
  payload?: string;
}

export interface WorkflowAuditResult {
  staleRunningCount: number;
  failedCount: number;
  staleInstances: WorkflowInstance[];
  failedInstances: WorkflowInstance[];
  recommendations: string[];
  indexWarning?: string;
}

const WORKFLOW_ROOT = '/var/workflow/instances';

/**
 * Detect stale and failed workflow instances.
 *
 * Uses the `workflowDataLucene` index on the `status` property.
 * Compatible with AEMaaCS and AEM 6.5/AMS.
 */
export async function workflowAudit(
  input: WorkflowAuditInput = {},
): Promise<WorkflowAuditResult | JobStartResult> {
  const { staleThresholdHours = 24, modelPath, includeFailed = true } = input;

  // Quick count
  const runningCount = await queryBuilder.count({
    type: 'cq:WorkflowInstance',
    path: WORKFLOW_ROOT,
    property: 'status',
    'property.value': 'RUNNING',
    ...(modelPath ? { '2_property': 'model', '2_property.value': modelPath } : {}),
  });

  const isLarge = runningCount > config.query.asyncThreshold;
  if (isLarge || input.async) {
    return jobManager.start(
      'aem_workflow_audit',
      { staleThresholdHours, modelPath, includeFailed },
      () => runWorkflowAudit(staleThresholdHours, modelPath, includeFailed),
      Math.max(15_000, runningCount * 20),
    );
  }

  return runWorkflowAudit(staleThresholdHours, modelPath, includeFailed);
}

async function runWorkflowAudit(
  staleThresholdHours: number,
  modelPath: string | undefined,
  includeFailed: boolean,
): Promise<WorkflowAuditResult> {
  const recommendations: string[] = [];
  const thresholdMs = staleThresholdHours * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - thresholdMs);

  const baseParams = {
    type: 'cq:WorkflowInstance',
    path: WORKFLOW_ROOT,
    'p.hits': 'selective',
    'p.properties': 'jcr:path model status startTime initiator data/payload',
    ...(modelPath ? { property: 'model', 'property.value': modelPath } : {}),
  };

  // Fetch RUNNING instances
  const runningResult = await queryBuilder.queryAll<Record<string, string>>(
    { ...baseParams, property: 'status', 'property.value': 'RUNNING' },
    5_000,
  );

  // Filter to stale (started before cutoff)
  const staleInstances: WorkflowInstance[] = [];
  for (const hit of runningResult.hits) {
    const startTime = hit['startTime'];
    if (startTime) {
      const started = new Date(parseInt(startTime, 10));
      if (started < cutoff) {
        staleInstances.push(mapInstance(hit));
      }
    } else {
      // No start time — conservatively flag it
      staleInstances.push(mapInstance(hit));
    }
  }

  // Fetch FAILED instances
  let failedInstances: WorkflowInstance[] = [];
  if (includeFailed) {
    const failedResult = await queryBuilder.queryAll<Record<string, string>>(
      { ...baseParams, property: 'status', 'property.value': 'FAILED' },
      5_000,
    );
    failedInstances = failedResult.hits.map(mapInstance);
  }

  // Build recommendations
  if (staleInstances.length > 0) {
    recommendations.push(
      `${staleInstances.length} workflow instance(s) have been RUNNING for more than ${staleThresholdHours}h. ` +
      `These may be stuck. Consider terminating or retrying from the Workflow console at /libs/cq/workflow/content/console.html.`,
    );
  }
  if (failedInstances.length > 0) {
    recommendations.push(
      `${failedInstances.length} workflow instance(s) are in FAILED state. ` +
      `Review and either retry or purge them to prevent repository bloat.`,
    );
  }
  if (staleInstances.length === 0 && failedInstances.length === 0) {
    recommendations.push('No stale or failed workflow instances detected.');
  }

  // Purge advice if combined count is high
  const total = staleInstances.length + failedInstances.length;
  if (total > 100) {
    recommendations.push(
      `High number of problem instances (${total}). Consider running a Workflow Purge maintenance task ` +
      `at /libs/granite/operations/content/maintenance.html to clean up completed instances and improve performance.`,
    );
  }

  return {
    staleRunningCount: staleInstances.length,
    failedCount: failedInstances.length,
    staleInstances,
    failedInstances,
    recommendations,
    indexWarning: runningResult.indexWarning,
  };
}

function mapInstance(hit: Record<string, string>): WorkflowInstance {
  return {
    path: hit['jcr:path'] ?? '',
    model: hit['model'] ?? '',
    status: hit['status'] ?? '',
    startTime: hit['startTime']
      ? new Date(parseInt(hit['startTime'], 10)).toISOString()
      : undefined,
    initiator: hit['initiator'],
    payload: hit['data/payload'],
  };
}
