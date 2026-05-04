import { queryBuilder } from '../query-builder.js';
import { aemClient, AemError } from '../aem-client.js';
import { jobManager, JobExecutionContext, JobStartResult } from '../job-manager.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withAssetLockMeta } from '../utils/asset-lock.js';

/**
 * AEM DAM "off time" expiry tooling.
 *
 *  - The DAM expiry mechanism is the `offTime` property on the asset's
 *    `jcr:content` node (xs:date / DATE in the JCR sense). When `offTime` is in
 *    the past, AEM treats the asset as expired and prevents publish/serve flows
 *    that respect activation windows.
 *
 *  - These tools are AUTHOR-ONLY. Mutating offTime against a publish instance
 *    is unsupported — content moves author → publish via replication. The
 *    instance type is read from `AEM_INSTANCE` (default: "author").
 *
 *  - Compatible with AEMaaCS (author tier) and AEM 6.5 / AMS author.
 */

const DISPLAY_LIMIT = 10;

function assertAuthorInstance(toolName: string): void {
  if (config.aem.instance !== 'author') {
    throw new Error(
      `${toolName} can only run against an AEM author instance. ` +
      `AEM_INSTANCE is currently "${config.aem.instance}". ` +
      `Set AEM_INSTANCE=author and point AEM_HOST at the author tier before retrying.`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Report: assets expiring within N days
// ───────────────────────────────────────────────────────────────────────────

export interface AssetExpiryReportInput {
  /** Find assets whose offTime falls within the next N days (from now). Required. */
  withinDays: number;
  /** DAM root to scope the scan. Defaults to AEM_DAM_ROOT. */
  damPath?: string;
  /** Include already-expired assets (offTime < now). Default: false. */
  includeExpired?: boolean;
  /** Hard cap on assets evaluated. Default: 5000. */
  maxAssets?: number;
}

export interface ExpiringAsset {
  assetPath: string;
  offTime: string;
  daysUntilExpiry: number;
}

export interface AssetExpiryReportResult {
  damPath: string;
  windowDays: number;
  now: string;
  cutoff: string;
  totalExpiringCount: number;
  displayedCount: number;
  truncated: boolean;
  displayedAssets: ExpiringAsset[];
  recommendations: string[];
  note: string;
}

export async function assetExpiryReport(
  input: AssetExpiryReportInput,
): Promise<AssetExpiryReportResult> {
  assertAuthorInstance('aem_asset_expiry_report');

  const {
    withinDays,
    damPath = config.aem.damRoot,
    includeExpired = false,
    maxAssets = 5000,
  } = input;

  if (!Number.isFinite(withinDays) || withinDays < 0) {
    throw new Error(`withinDays must be a non-negative number, got "${withinDays}".`);
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() + withinDays * 86_400_000);

  // Why we don't filter offTime inside QueryBuilder:
  //   1. The `daterange` predicate calls Property.getDate() and silently
  //      skips String-typed offTime values. AEM commonly stores offTime as
  //      a JCR String containing a JS Date.toString() form like
  //      "Sun May 10 2026 23:33:00 GMT+0530" (CRX/DE, scripts without
  //      TypeHint, AEM workflow scripts).
  //   2. The `property` predicate with `operation=exists` and a relative
  //      path like `jcr:content/offTime` does not reliably navigate through
  //      jcr:content for `type=dam:Asset` results — it returns 0 hits even
  //      when the property exists.
  //   3. offTime is not in the default damAssetLucene covering index, so
  //      any property-based filter would post-filter or traverse anyway.
  //
  // Reliable strategy: enumerate dam:Asset paths under damPath, then
  // fetch each asset's jcr:content to read offTime in-memory. Batched to
  // bound concurrency. Same pattern as page-property-report's batched scan.
  const assetsResult = await queryBuilder.queryAll<Record<string, unknown>>(
    {
      type: 'dam:Asset',
      path: damPath,
      'p.hits': 'selective',
      'p.properties': 'jcr:path',
    },
    maxAssets,
  );
  const assetPaths = assetsResult.hits
    .map(h => String(h['jcr:path'] ?? ''))
    .filter(Boolean);

  const expiring: ExpiringAsset[] = [];
  const batchSize = 30;
  for (let i = 0; i < assetPaths.length; i += batchSize) {
    const batch = assetPaths.slice(i, i + batchSize);
    await Promise.all(batch.map(async (assetPath) => {
      let offTimeRaw: unknown;
      try {
        const content = await aemClient.getNode<Record<string, unknown>>(
          `${assetPath}/jcr:content`,
        );
        offTimeRaw = content['offTime'];
      } catch (e) {
        logger.warn(`Could not read jcr:content for ${assetPath}`, e);
        return;
      }

      if (offTimeRaw === undefined || offTimeRaw === null || offTimeRaw === '') return;

      const offTimeStr = String(offTimeRaw);
      const offTimeDate = new Date(offTimeStr);
      if (Number.isNaN(offTimeDate.getTime())) {
        logger.warn(`Skipping ${assetPath}: unparsable offTime "${offTimeStr}"`);
        return;
      }

      if (!includeExpired && offTimeDate.getTime() < now.getTime()) return;
      if (offTimeDate.getTime() > cutoff.getTime()) return;

      const daysUntilExpiry = Math.round(
        (offTimeDate.getTime() - now.getTime()) / 86_400_000,
      );
      expiring.push({ assetPath, offTime: offTimeDate.toISOString(), daysUntilExpiry });
    }));

    if (i + batchSize < assetPaths.length) {
      await new Promise(r => setTimeout(r, config.query.batchDelayMs));
    }
  }

  expiring.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  const totalExpiringCount = expiring.length;
  const displayedAssets = expiring.slice(0, DISPLAY_LIMIT);
  const truncated = totalExpiringCount > DISPLAY_LIMIT;

  const recommendations: string[] = [];
  if (totalExpiringCount === 0) {
    recommendations.push(
      `No assets under ${damPath} are expiring within the next ${withinDays} day(s).`,
    );
  } else {
    recommendations.push(
      `${totalExpiringCount} asset(s) under ${damPath} have offTime within the next ${withinDays} day(s).`,
    );
    if (truncated) {
      recommendations.push(
        `Only the first ${DISPLAY_LIMIT} (sorted by soonest expiry) are listed. ` +
        `Use aem_extend_asset_expiry with withinDays=${withinDays} to bulk-extend, ` +
        `or pass a list of assetPaths to extend a specific subset.`,
      );
    }
  }

  return {
    damPath,
    windowDays: withinDays,
    now: now.toISOString(),
    cutoff: cutoff.toISOString(),
    totalExpiringCount,
    displayedCount: displayedAssets.length,
    truncated,
    displayedAssets,
    recommendations,
    note:
      'offTime is the DAM expiry property on jcr:content. Assets with offTime in the past ' +
      'are treated as expired by AEM activation windows. This tool runs only on the author tier.',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Extend: shift offTime forward
// ───────────────────────────────────────────────────────────────────────────

export interface ExtendAssetExpiryInput {
  /** Explicit list of asset paths to update. Mutually exclusive with `withinDays`. */
  assetPaths?: string[];
  /** Update every asset under damPath whose offTime falls within this many days. */
  withinDays?: number;
  damPath?: string;
  /** Number of days to add to the asset's current offTime. Mutually exclusive with `newOffTime`. */
  extendByDays?: number;
  /** Absolute new offTime (ISO 8601). Mutually exclusive with `extendByDays`. */
  newOffTime?: string;
  /** Absolute new onTime / go-live date (ISO 8601). Independent of offTime fields. */
  newOnTime?: string;
  /**
   * If true, replicate (Activate) each successfully updated asset to publish
   * after the property update. Replication runs as a second batched phase.
   * The CALLING AGENT must obtain explicit user consent before passing
   * publish=true — this is a destructive change visible to publish consumers.
   */
  publish?: boolean;
  /** Don't actually write — preview only. Default: false. */
  dryRun?: boolean;
  /** Update / replication batch size. Default: 25. */
  batchSize?: number;
  /** Hard cap when using withinDays. Default: 5000. */
  maxAssets?: number;
  async?: boolean;
}

export type AssetUpdateStatus = 'updated' | 'skipped' | 'failed' | 'dry-run';
export type AssetReplicationStatus = 'not-attempted' | 'replicated' | 'failed';

export interface ExtendAssetExpiryItemResult {
  assetPath: string;
  previousOnTime: string | null;
  previousOffTime: string | null;
  newOnTime: string | null;
  newOffTime: string | null;
  status: AssetUpdateStatus;
  error?: string;
  replicationStatus: AssetReplicationStatus;
  replicationError?: string;
  /**
   * Time this asset's update spent waiting on a per-asset lock held by a
   * concurrent MCP session. 0 when the lock was free. Useful for surfacing
   * contention in tool output.
   */
  lockWaitedMs?: number;
}

export interface ExtendAssetExpiryResult {
  damPath: string;
  totalCandidates: number;
  processed: number;
  updated: number;
  failed: number;
  skipped: number;
  dryRun: boolean;
  publishRequested: boolean;
  replicated: number;
  replicationFailed: number;
  /** Asset paths that were updated but failed to replicate. */
  failedReplicationPaths: string[];
  items: ExtendAssetExpiryItemResult[];
  recommendations: string[];
}

export async function extendAssetExpiry(
  input: ExtendAssetExpiryInput,
): Promise<ExtendAssetExpiryResult | JobStartResult> {
  assertAuthorInstance('aem_extend_asset_expiry');

  const {
    assetPaths,
    withinDays,
    damPath = config.aem.damRoot,
    extendByDays,
    newOffTime,
    newOnTime,
    publish = false,
    dryRun = false,
    batchSize = 25,
    maxAssets = 5000,
  } = input;

  // ─ Input validation ─
  if (!assetPaths && withinDays === undefined) {
    throw new Error('Provide either `assetPaths` or `withinDays`.');
  }
  if (assetPaths && withinDays !== undefined) {
    throw new Error('`assetPaths` and `withinDays` are mutually exclusive.');
  }

  // At least one mutation must be requested.
  if (extendByDays === undefined && !newOffTime && !newOnTime) {
    throw new Error('Provide at least one of `extendByDays`, `newOffTime`, or `newOnTime`.');
  }
  if (extendByDays !== undefined && newOffTime) {
    throw new Error('`extendByDays` and `newOffTime` are mutually exclusive.');
  }
  if (extendByDays !== undefined && (!Number.isFinite(extendByDays) || extendByDays <= 0)) {
    throw new Error(`extendByDays must be a positive number, got "${extendByDays}".`);
  }

  let resolvedNewOffTime: string | undefined;
  if (newOffTime) {
    const parsed = new Date(newOffTime);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`newOffTime is not a valid date: "${newOffTime}". Provide an ISO 8601 string, e.g. "2026-12-31T23:59:59Z".`);
    }
    resolvedNewOffTime = parsed.toISOString();
  }
  let resolvedNewOnTime: string | undefined;
  if (newOnTime) {
    const parsed = new Date(newOnTime);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`newOnTime is not a valid date: "${newOnTime}". Provide an ISO 8601 string, e.g. "2026-05-20T00:00:00Z".`);
    }
    resolvedNewOnTime = parsed.toISOString();
  }
  if (resolvedNewOnTime && resolvedNewOffTime) {
    if (new Date(resolvedNewOnTime).getTime() > new Date(resolvedNewOffTime).getTime()) {
      throw new Error(`newOnTime (${resolvedNewOnTime}) is after newOffTime (${resolvedNewOffTime}). The asset would never be live.`);
    }
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize must be a positive number, got "${batchSize}".`);
  }

  // Resolve candidate list
  let candidates: string[];
  if (assetPaths) {
    candidates = assetPaths.filter(p => p && p.startsWith('/content/dam'));
    if (candidates.length !== assetPaths.length) {
      logger.warn(
        `Ignoring ${assetPaths.length - candidates.length} asset path(s) outside /content/dam`,
      );
    }
  } else {
    candidates = await collectExpiringAssetPaths(damPath, withinDays!, maxAssets);
  }

  const opts: RunExtendOptions = {
    extendByDays,
    newOffTime: resolvedNewOffTime,
    newOnTime: resolvedNewOnTime,
    publish,
    dryRun,
    batchSize,
    damPath,
  };

  // Async dispatch when bulk
  if ((candidates.length > config.query.asyncThreshold || input.async) && !dryRun) {
    return jobManager.start(
      'aem_extend_asset_expiry',
      {
        candidateCount: candidates.length,
        damPath,
        extendByDays,
        newOffTime: resolvedNewOffTime,
        newOnTime: resolvedNewOnTime,
        publish,
        batchSize,
      },
      (ctx) => runExtend(candidates, opts, ctx),
      Math.max(20_000, candidates.length * (publish ? 200 : 100)),
    );
  }

  return runExtend(candidates, opts);
}

interface RunExtendOptions {
  extendByDays: number | undefined;
  newOffTime: string | undefined;
  newOnTime: string | undefined;
  publish: boolean;
  dryRun: boolean;
  batchSize: number;
  damPath: string;
}

async function collectExpiringAssetPaths(
  damPath: string,
  withinDays: number,
  maxAssets: number,
): Promise<string[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() + withinDays * 86_400_000);

  // Same rationale as assetExpiryReport: enumerate paths via QueryBuilder,
  // then read jcr:content per asset and filter offTime in-memory. The
  // QueryBuilder daterange/exists predicates are unreliable against
  // jcr:content/offTime on dam:Asset.
  const result = await queryBuilder.queryAll<Record<string, unknown>>(
    {
      type: 'dam:Asset',
      path: damPath,
      'p.hits': 'selective',
      'p.properties': 'jcr:path',
    },
    maxAssets,
  );
  const assetPaths = result.hits.map(h => String(h['jcr:path'] ?? '')).filter(Boolean);

  const matching: string[] = [];
  const batchSize = 30;
  for (let i = 0; i < assetPaths.length; i += batchSize) {
    const batch = assetPaths.slice(i, i + batchSize);
    await Promise.all(batch.map(async (assetPath) => {
      try {
        const content = await aemClient.getNode<Record<string, unknown>>(
          `${assetPath}/jcr:content`,
        );
        const offTimeRaw = content['offTime'];
        if (offTimeRaw === undefined || offTimeRaw === null || offTimeRaw === '') return;
        const offTimeDate = new Date(String(offTimeRaw));
        if (Number.isNaN(offTimeDate.getTime())) return;
        if (offTimeDate.getTime() < now.getTime()) return;
        if (offTimeDate.getTime() > cutoff.getTime()) return;
        matching.push(assetPath);
      } catch {
        // best-effort
      }
    }));

    if (i + batchSize < assetPaths.length) {
      await new Promise(r => setTimeout(r, config.query.batchDelayMs));
    }
  }
  return matching;
}

async function runExtend(
  candidates: string[],
  opts: RunExtendOptions,
  ctx?: JobExecutionContext,
): Promise<ExtendAssetExpiryResult> {
  const { extendByDays, newOffTime, newOnTime, publish, dryRun, batchSize, damPath } = opts;

  const checkpoint = ctx?.getCheckpoint<{
    phase?: 'update' | 'publish';
    items?: ExtendAssetExpiryItemResult[];
    nextUpdateIndex?: number;
    nextPublishIndex?: number;
  }>();

  const items: ExtendAssetExpiryItemResult[] = checkpoint?.items ?? [];
  let phase: 'update' | 'publish' = checkpoint?.phase ?? 'update';

  // ── Phase 1: property updates ──────────────────────────────────────────
  if (phase === 'update') {
    const startIndex = checkpoint?.nextUpdateIndex ?? 0;
    for (let i = startIndex; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchIndex = Math.floor(i / batchSize);
      const totalBatches = Math.ceil(candidates.length / batchSize);

      await ctx?.heartbeat({
        checkpoint: { phase: 'update', items, nextUpdateIndex: i },
        progressPercent: Math.round((batchIndex / Math.max(totalBatches, 1)) * (publish ? 50 : 100)),
        message: `Updating activation window — batch ${batchIndex + 1}/${totalBatches} (${batch.length} assets).`,
      });

      // Per-asset lock: serialise concurrent writers across MCP sessions on
      // the SAME asset. Different assets in this batch still run in parallel.
      const batchResults = await Promise.all(batch.map(async (assetPath) => {
        const { result, waited, waitedMs } = await withAssetLockMeta(
          assetPath,
          () => updateAssetActivationWindow(
            assetPath,
            extendByDays,
            newOffTime,
            newOnTime,
            dryRun,
          ),
        );
        if (waited) {
          result.lockWaitedMs = waitedMs;
          logger.info(
            `Asset ${assetPath}: waited ${waitedMs}ms for lock held by another MCP session.`,
          );
        }
        return result;
      }));
      // Build deterministic order (matches batch order) — fixes the
      // non-deterministic ordering noted in the code review.
      items.push(...batchResults);

      ctx?.saveCheckpoint({ phase: 'update', items, nextUpdateIndex: i + batch.length });

      if (i + batchSize < candidates.length) {
        await new Promise(r => setTimeout(r, config.query.batchDelayMs));
      }
    }
    phase = 'publish';
    ctx?.saveCheckpoint({ phase: 'publish', items, nextPublishIndex: 0 });
  }

  // ── Phase 2: replication (only for successfully updated, non-dry-run) ──
  if (publish && !dryRun) {
    const replicable = items.filter(i => i.status === 'updated');
    const startIndex = checkpoint?.phase === 'publish' ? (checkpoint.nextPublishIndex ?? 0) : 0;

    for (let i = startIndex; i < replicable.length; i += batchSize) {
      const batch = replicable.slice(i, i + batchSize);
      const batchIndex = Math.floor(i / batchSize);
      const totalBatches = Math.ceil(replicable.length / batchSize);

      await ctx?.heartbeat({
        checkpoint: { phase: 'publish', items, nextPublishIndex: i },
        progressPercent: 50 + Math.round((batchIndex / Math.max(totalBatches, 1)) * 50),
        message: `Replicating to publish — batch ${batchIndex + 1}/${totalBatches} (${batch.length} assets).`,
      });

      await Promise.all(batch.map(async (item) => {
        const r = await replicateAsset(item.assetPath);
        if (r.ok) {
          item.replicationStatus = 'replicated';
        } else {
          item.replicationStatus = 'failed';
          item.replicationError = r.error;
        }
      }));

      ctx?.saveCheckpoint({ phase: 'publish', items, nextPublishIndex: i + batch.length });

      if (i + batchSize < replicable.length) {
        await new Promise(r => setTimeout(r, config.query.batchDelayMs));
      }
    }
  }

  // ── Aggregate ──────────────────────────────────────────────────────────
  const updated = items.filter(i => i.status === 'updated' || i.status === 'dry-run').length;
  const failed = items.filter(i => i.status === 'failed').length;
  const skipped = items.filter(i => i.status === 'skipped').length;
  const replicated = items.filter(i => i.replicationStatus === 'replicated').length;
  const replicationFailed = items.filter(i => i.replicationStatus === 'failed').length;
  const failedReplicationPaths = items
    .filter(i => i.replicationStatus === 'failed')
    .map(i => i.assetPath);

  const recommendations: string[] = [];
  if (dryRun) {
    recommendations.push(
      `Dry run: ${items.length} asset(s) would be updated. ` +
      `Re-run with dryRun=false to apply.${publish ? ' Publish step is also skipped in dry run.' : ''}`,
    );
  } else {
    if (failed > 0) {
      recommendations.push(
        `${failed} property update(s) failed. Inspect items[].error for details. ` +
        `Common causes: insufficient ACLs on jcr:content, asset locked by another session, or invalid date format.`,
      );
    }
    if (publish) {
      if (replicationFailed > 0) {
        recommendations.push(
          `${replicationFailed} asset(s) failed to replicate to publish. ` +
          `Failed paths: ${failedReplicationPaths.slice(0, 10).join(', ')}` +
          `${failedReplicationPaths.length > 10 ? ` (+${failedReplicationPaths.length - 10} more, see items[])` : ''}. ` +
          `Inspect items[].replicationError for per-asset reasons. Common causes: replication agent disabled, queue blocked, or AEMaaCS Sling Content Distribution backpressure.`,
        );
      }
      if (replicated > 0) {
        recommendations.push(
          `${replicated} asset(s) successfully replicated to publish.`,
        );
      }
    } else if (updated > 0) {
      recommendations.push(
        `${updated} asset(s) updated on author. Replication was NOT triggered (publish=false). ` +
        `Re-call this tool with the same assetPaths and publish=true (after obtaining user consent) to push to publish.`,
      );
    }
  }

  return {
    damPath,
    totalCandidates: candidates.length,
    processed: items.length,
    updated,
    failed,
    skipped,
    dryRun,
    publishRequested: publish,
    replicated,
    replicationFailed,
    failedReplicationPaths,
    items,
    recommendations,
  };
}

async function replicateAsset(
  assetPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await aemClient.post('/bin/replicate.json', {
      path: assetPath,
      cmd: 'Activate',
    });
    return { ok: true };
  } catch (e) {
    const error = e instanceof AemError
      ? `AEM ${e.statusCode} on ${e.url}`
      : (e instanceof Error ? e.message : String(e));
    return { ok: false, error };
  }
}

async function updateAssetActivationWindow(
  assetPath: string,
  extendByDays: number | undefined,
  newOffTime: string | undefined,
  newOnTime: string | undefined,
  dryRun: boolean,
): Promise<ExtendAssetExpiryItemResult> {
  const contentPath = `${assetPath}/jcr:content`;

  const baseItem: ExtendAssetExpiryItemResult = {
    assetPath,
    previousOnTime: null,
    previousOffTime: null,
    newOnTime: null,
    newOffTime: null,
    status: 'failed',
    replicationStatus: 'not-attempted',
  };

  // Read existing onTime/offTime. Missing values are NOT an error — many
  // assets will have neither set (e.g. assets created via standard upload
  // with no activation window configured).
  let previousOnTime: string | null = null;
  let previousOffTime: string | null = null;
  try {
    const content = await aemClient.getNode<Record<string, unknown>>(contentPath);
    if (content['onTime'] !== undefined && content['onTime'] !== null) {
      previousOnTime = String(content['onTime']);
    }
    if (content['offTime'] !== undefined && content['offTime'] !== null) {
      previousOffTime = String(content['offTime']);
    }
  } catch (e) {
    return {
      ...baseItem,
      error: `Failed to read jcr:content: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── Compute new offTime (if requested) ─────────────────────────────────
  let computedOffIso: string | null = null;
  if (newOffTime) {
    // Caller-supplied absolute value (already validated upstream).
    computedOffIso = new Date(newOffTime).toISOString();
  } else if (extendByDays !== undefined) {
    // Extension mode. If the asset has no existing offTime, fall back to
    // "now" — equivalent to "activate this asset for `extendByDays` days
    // starting today". This keeps the tool useful for assets that have
    // never had an activation window.
    const base = previousOffTime ? new Date(previousOffTime) : new Date();
    if (Number.isNaN(base.getTime())) {
      return {
        ...baseItem,
        previousOnTime,
        previousOffTime,
        error: `Existing offTime "${previousOffTime}" is not a valid date and cannot be extended. ` +
          `Use newOffTime (absolute) instead of extendByDays for this asset.`,
      };
    }
    computedOffIso = new Date(base.getTime() + extendByDays * 86_400_000).toISOString();
  }

  // ── Compute new onTime (if requested) ──────────────────────────────────
  const computedOnIso = newOnTime ? new Date(newOnTime).toISOString() : null;

  // ── Per-asset ordering check (extension + onTime combo) ────────────────
  if (computedOnIso && computedOffIso) {
    if (new Date(computedOnIso).getTime() > new Date(computedOffIso).getTime()) {
      return {
        ...baseItem,
        previousOnTime,
        previousOffTime,
        error: `Computed onTime (${computedOnIso}) is after computed offTime (${computedOffIso}). The asset would never be live.`,
      };
    }
  }
  // Also check against existing values when only one side is being changed.
  if (computedOnIso && !computedOffIso && previousOffTime) {
    const existingOff = new Date(previousOffTime);
    if (!Number.isNaN(existingOff.getTime()) && new Date(computedOnIso).getTime() > existingOff.getTime()) {
      return {
        ...baseItem,
        previousOnTime,
        previousOffTime,
        error: `New onTime (${computedOnIso}) is after the asset's existing offTime (${previousOffTime}). Update offTime as well.`,
      };
    }
  }

  if (!computedOnIso && !computedOffIso) {
    // No mutation applies (shouldn't reach here given upstream validation).
    return {
      ...baseItem,
      previousOnTime,
      previousOffTime,
      status: 'skipped',
    };
  }

  if (dryRun) {
    return {
      ...baseItem,
      previousOnTime,
      previousOffTime,
      newOnTime: computedOnIso,
      newOffTime: computedOffIso,
      status: 'dry-run',
    };
  }

  // ── Write via Sling POST ───────────────────────────────────────────────
  const formData: Record<string, string> = {};
  if (computedOffIso) {
    formData['offTime'] = computedOffIso;
    formData['offTime@TypeHint'] = 'Date';
  }
  if (computedOnIso) {
    formData['onTime'] = computedOnIso;
    formData['onTime@TypeHint'] = 'Date';
  }

  try {
    await aemClient.post(contentPath, formData);
    return {
      ...baseItem,
      previousOnTime,
      previousOffTime,
      newOnTime: computedOnIso,
      newOffTime: computedOffIso,
      status: 'updated',
    };
  } catch (e) {
    const message = e instanceof AemError
      ? `AEM ${e.statusCode} on ${e.url}`
      : (e instanceof Error ? e.message : String(e));
    return {
      ...baseItem,
      previousOnTime,
      previousOffTime,
      error: message,
    };
  }
}
