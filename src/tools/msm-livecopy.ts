import { queryBuilder } from '../query-builder.js';
import { aemClient } from '../aem-client.js';
import { jobManager, JobStartResult } from '../job-manager.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface MsmLiveCopyInput {
  /** Root path to scan for live copy configs. Defaults to AEM_CONTENT_ROOT */
  rootPath?: string;
  /** If true, only return out-of-sync copies */
  outOfSyncOnly?: boolean;
  async?: boolean;
}

export interface LiveCopyEntry {
  liveCopyPath: string;
  masterPath: string;
  lastRolledOut?: string;
  masterLastModified?: string;
  isOutOfSync: boolean;
  isSuspended: boolean;
  cancelledProperties: string[];
  cancelledChildren: string[];
  rolloutConfigs: string[];
  syncStatus: 'IN_SYNC' | 'OUT_OF_SYNC' | 'SUSPENDED' | 'UNKNOWN';
}

export interface MsmLiveCopyResult {
  rootPath: string;
  totalLiveCopies: number;
  outOfSyncCount: number;
  suspendedCount: number;
  liveCopies: LiveCopyEntry[];
  recommendations: string[];
  indexWarning?: string;
}

/**
 * Analyse MSM live copy synchronisation status.
 *
 * Uses JCR properties on cq:LiveSyncConfig nodes (indexed via nodetype).
 * Compatible with AEMaaCS and AEM 6.5/AMS.
 */
export async function msmLiveCopyStatus(
  input: MsmLiveCopyInput = {},
): Promise<MsmLiveCopyResult | JobStartResult> {
  const { rootPath = config.aem.contentRoot, outOfSyncOnly = false } = input;

  const total = await queryBuilder.count({
    type: 'cq:LiveSyncConfig',
    path: rootPath,
  });

  if (total > config.query.asyncThreshold || input.async) {
    return jobManager.start(
      'aem_msm_livecopy_status',
      { rootPath, outOfSyncOnly },
      () => runMsmAnalysis(rootPath, outOfSyncOnly),
      Math.max(20_000, total * 50),
    );
  }

  return runMsmAnalysis(rootPath, outOfSyncOnly);
}

async function runMsmAnalysis(
  rootPath: string,
  outOfSyncOnly: boolean,
): Promise<MsmLiveCopyResult> {
  const recommendations: string[] = [];

  // Query all LiveSyncConfig nodes — these are the live copy roots
  const result = await queryBuilder.queryAll<Record<string, unknown>>(
    {
      type: 'cq:LiveSyncConfig',
      path: rootPath,
      'p.hits': 'selective',
      'p.properties': 'jcr:path cq:master cq:isDeep cq:rolloutConfigs',
    },
    5_000,
  );

  const liveCopies: LiveCopyEntry[] = [];

  for (const hit of result.hits) {
    const configPath = String(hit['jcr:path'] ?? '');
    // LiveSyncConfig lives at: /content/site/livecopy/jcr:content/...
    // The live copy page path is two levels up from the config node
    const liveCopyPath = configPath.replace(/\/jcr:content.*$/, '');
    const masterPath = String(hit['cq:master'] ?? '');

    if (!masterPath) continue;

    let entry: LiveCopyEntry = {
      liveCopyPath,
      masterPath,
      isOutOfSync: false,
      isSuspended: false,
      cancelledProperties: [],
      cancelledChildren: [],
      rolloutConfigs: normaliseArray(hit['cq:rolloutConfigs']),
      syncStatus: 'UNKNOWN',
    };

    // Read the actual LiveSync mixin on the jcr:content node for deeper info
    try {
      const jcrContent = await aemClient.getNode<Record<string, unknown>>(
        `${liveCopyPath}/jcr:content`,
      );
      entry = enrichEntry(entry, jcrContent);
    } catch (e) {
      logger.warn(`Could not read jcr:content for ${liveCopyPath}`, e);
    }

    // Check master last modified vs live copy last rolled out
    if (entry.lastRolledOut && !entry.isSuspended) {
      try {
        const masterContent = await aemClient.getNode<Record<string, unknown>>(
          `${masterPath}/jcr:content`,
        );
        const masterModified = String(masterContent['cq:lastModified'] ?? '');
        if (masterModified) {
          entry.masterLastModified = masterModified;
          const rolledOutDate = new Date(entry.lastRolledOut);
          const masterModDate = new Date(masterModified);
          entry.isOutOfSync = masterModDate > rolledOutDate;
        }
      } catch { /* master may be inaccessible */ }
    }

    entry.syncStatus = determineSyncStatus(entry);

    if (!outOfSyncOnly || entry.isOutOfSync || entry.isSuspended) {
      liveCopies.push(entry);
    }
  }

  const outOfSyncCount = liveCopies.filter(lc => lc.isOutOfSync).length;
  const suspendedCount = liveCopies.filter(lc => lc.isSuspended).length;

  // Recommendations
  if (outOfSyncCount > 0) {
    recommendations.push(
      `${outOfSyncCount} live cop${outOfSyncCount === 1 ? 'y' : 'ies'} are out of sync with their language master. ` +
      `Run a rollout from the master page to propagate changes.`,
    );
  }
  if (suspendedCount > 0) {
    recommendations.push(
      `${suspendedCount} live cop${suspendedCount === 1 ? 'y' : 'ies'} have inheritance suspended. ` +
      `Review whether suspension is intentional or accidental.`,
    );
  }

  // Pages with cancelled properties (broken inheritance at property level)
  const cancelledPropCount = liveCopies.filter(lc => lc.cancelledProperties.length > 0).length;
  if (cancelledPropCount > 0) {
    recommendations.push(
      `${cancelledPropCount} live cop${cancelledPropCount === 1 ? 'y' : 'ies'} have individual property inheritance cancelled. ` +
      `Verify this is intentional content variation.`,
    );
  }

  if (outOfSyncCount === 0 && suspendedCount === 0) {
    recommendations.push('All live copies are in sync with their language masters.');
  }

  return {
    rootPath,
    totalLiveCopies: result.total,
    outOfSyncCount,
    suspendedCount,
    liveCopies,
    recommendations,
    indexWarning: result.indexWarning,
  };
}

function enrichEntry(
  entry: LiveCopyEntry,
  jcrContent: Record<string, unknown>,
): LiveCopyEntry {
  const mixins = normaliseArray(jcrContent['jcr:mixinTypes']);
  const hasMixin = mixins.includes('cq:LiveRelationship');

  if (hasMixin) {
    entry.lastRolledOut = String(jcrContent['cq:lastRolledout'] ?? '');
    entry.isSuspended = jcrContent['cq:isSuspended'] === true || jcrContent['cq:isSuspended'] === 'true';
    entry.cancelledProperties = normaliseArray(jcrContent['cq:propertyInheritanceCancelled']);
    entry.cancelledChildren = normaliseArray(jcrContent['cq:childrenCancelled']);
  }

  return entry;
}

function determineSyncStatus(entry: LiveCopyEntry): LiveCopyEntry['syncStatus'] {
  if (entry.isSuspended) return 'SUSPENDED';
  if (entry.isOutOfSync) return 'OUT_OF_SYNC';
  if (entry.lastRolledOut) return 'IN_SYNC';
  return 'UNKNOWN';
}

function normaliseArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}
