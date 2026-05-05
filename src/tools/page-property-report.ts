import { queryBuilder } from '../query-builder.js';
import { aemClient } from '../aem-client.js';
import { jobManager, JobExecutionContext, JobStartResult } from '../job-manager.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface PagePropertyReportInput {
  /** The JCR property name to report on (e.g. "cq:template", "jcr:title", "hideInNav", "sling:vanityPath") */
  property: string;
  /** Optional: match value. For analyzed text properties like jcr:title, this behaves like a term/contains search. */
  propertyValue?: string;
  /** Optional: report pages that are MISSING the property (mutually exclusive with propertyValue) */
  reportMissing?: boolean;
  /**
   * Root path to search.
   *
   * MSM-aware defaults:
   *  - If the path contains a language master (detected by MSM config), the tool
   *    defaults to that master path and offers to extend to a live copy.
   *  - Pass a specific country/locale path (e.g. /content/mysite/us/en) to scope to a live copy.
   *
   * Defaults to AEM_CONTENT_ROOT if not provided.
   */
  rootPath?: string;
  /**
   * Scope hint:
   *  - "master"    — search language master only (default when MSM detected)
   *  - "livecopy"  — search within rootPath as a live copy tree
   *  - "all"       — search entire rootPath regardless of MSM
   */
  scope?: 'master' | 'livecopy' | 'all';
  /** Max pages (default: 5000) */
  maxPages?: number;
  async?: boolean;
}

export interface PagePropertyEntry {
  pagePath: string;
  propertyValue: string | string[] | null;
  /** For missing-property reports */
  isMissing: boolean;
}

export interface PagePropertyReportResult {
  property: string;
  rootPath: string;
  scope: string;
  totalPagesScanned: number;
  matchingPageCount: number;
  pages: PagePropertyEntry[];
  msmContext?: {
    isMsmSite: boolean;
    detectedMasterPath?: string;
    note: string;
  };
  recommendations: string[];
  indexWarning?: string;
  telemetry?: PagePropertyReportTelemetry;
}

export interface PagePropertyReportTelemetry {
  strategy: 'fast-indexed-query' | 'batched-property-scan';
  propertyReadPath: string;
  candidatePageCount: number;
  returnedPageCount: number;
  queryHitValueCount: number;
  queryHitValueSources?: Record<string, number>;
  fallbackReadCount: number;
  fallbackValueCount: number;
  missingValueCount: number;
  readFailureCount: number;
  sampleHitKeys?: string[];
}

/**
 * Generate a report of pages based on a JCR property.
 *
 * MSM-aware:
 *  - Detects whether the site uses MSM (live copies present).
 *  - Defaults to the language master path when MSM is detected.
 *  - Allows scoping to a specific live copy path for country/locale comparisons.
 *
 * Query safety:
 *  - For well-known indexed properties (cq:template, jcr:title, etc.) uses
 *    QueryBuilder property filter — fast.
 *  - For non-indexed (custom) properties: fetches all pages in batches and
 *    checks property in-memory — warns user about potential performance impact.
 */
export async function pagePropertyReport(
  input: PagePropertyReportInput,
): Promise<PagePropertyReportResult | JobStartResult> {
  const {
    property,
    propertyValue,
    reportMissing = false,
    rootPath = config.aem.contentRoot,
    scope = 'all',
    maxPages = 5000,
  } = input;

  // MSM detection
  const msmContext = await detectMsmContext(rootPath);
  const effectivePath = determineEffectivePath(rootPath, scope, msmContext);

  const pageCount = Math.min(
    await queryBuilder.count({ type: 'cq:Page', path: effectivePath }),
    maxPages,
  );

  if (pageCount > config.query.asyncThreshold || input.async) {
    return jobManager.start(
      'aem_page_property_report',
      { property, propertyValue, reportMissing, rootPath: effectivePath, scope, maxPages },
      (ctx) => runPropertyReport(property, propertyValue, reportMissing, effectivePath, maxPages, scope, msmContext, ctx),
      Math.max(20_000, pageCount * 50),
    );
  }

  return runPropertyReport(property, propertyValue, reportMissing, effectivePath, maxPages, scope, msmContext);
}

async function runPropertyReport(
  property: string,
  propertyValue: string | undefined,
  reportMissing: boolean,
  rootPath: string,
  maxPages: number,
  scope: string,
  msmContext: MsmContext,
  ctx?: JobExecutionContext,
): Promise<PagePropertyReportResult> {
  const recommendations: string[] = [];

  const isKnownIndexed = isIndexedProperty(property);
  let indexWarning: string | undefined;

  if (!isKnownIndexed) {
    indexWarning =
      `Property "${property}" is not in the known Oak index list. ` +
      `Pages will be fetched in batches and the property checked in-memory. ` +
      `This is slower than an indexed query but safe — processing is batched.`;
    logger.warn(indexWarning);
  }

  let pages: PagePropertyEntry[] = [];
  let telemetry: PagePropertyReportTelemetry;

  if (isKnownIndexed && !reportMissing) {
    // Fast path: use QueryBuilder with property filter
    const report = await fastIndexedQuery(property, propertyValue, rootPath, maxPages);
    pages = report.pages;
    telemetry = report.telemetry;
  } else {
    // Slow path: fetch all pages and check property in-memory (batched)
    const report = await batchedPropertyScan(property, propertyValue, reportMissing, rootPath, maxPages, ctx);
    pages = report.pages;
    telemetry = report.telemetry;
  }

  // Recommendations
  if (reportMissing && pages.length > 0) {
    recommendations.push(
      `${pages.length} page(s) are missing the property "${property}". ` +
      `This may indicate incomplete content authoring.`,
    );
  }
  if (!reportMissing && propertyValue && pages.length === 0) {
    recommendations.push(
      `No pages found matching ${property}="${propertyValue}" under ${rootPath}.`,
    );
  }
  if (msmContext.isMsmSite && scope !== 'all') {
    recommendations.push(
      `MSM site detected. Results are scoped to ${scope === 'master' ? 'the language master' : 'the specified live copy'}. ` +
      `Use scope="all" to query across all live copies, or pass a specific country path.`,
    );
  }

  return {
    property,
    rootPath,
    scope,
    totalPagesScanned: pages.length,
    matchingPageCount: reportMissing
      ? pages.length
      : pages.filter(p => !p.isMissing).length,
    pages,
    msmContext: {
      isMsmSite: msmContext.isMsmSite,
      detectedMasterPath: msmContext.masterPath,
      note: msmContext.isMsmSite
        ? `MSM site detected. Language master path: ${msmContext.masterPath ?? 'unknown'}. ` +
          `To query a specific live copy (e.g. US English), pass rootPath="/content/mysite/us/en" and scope="livecopy".`
        : 'No MSM live copy configuration detected under this path.',
    },
    recommendations,
    indexWarning,
    telemetry,
  };
}

// ─── Query strategies ──────────────────────────────────────────────────────────

async function fastIndexedQuery(
  property: string,
  propertyValue: string | undefined,
  rootPath: string,
  maxPages: number,
): Promise<{ pages: PagePropertyEntry[]; telemetry: PagePropertyReportTelemetry }> {
  const propertyPath = `jcr:content/${property}`;
  const params: Record<string, string | number | boolean> = {
    type: 'cq:Page',
    path: rootPath,
    'p.hits': 'selective',
    'p.properties': `jcr:path ${propertyPath}`,
  };

  if (propertyValue !== undefined) {
    if (supportsScopedFulltext(property)) {
      params['fulltext'] = propertyValue;
      params['fulltext.relPath'] = propertyPath;
    } else {
      params['property'] = propertyPath;
      params['property.value'] = propertyValue;
    }
  } else {
    params['property'] = propertyPath;
  }

  logger.debug('[page-property-report] Fast indexed query starting', {
    property,
    rootPath,
    maxPages,
    hasValueFilter: propertyValue !== undefined,
    propertyPath,
  });

  const result = await queryBuilder.queryAll<Record<string, unknown>>(params, maxPages);

  const telemetry: PagePropertyReportTelemetry = {
    strategy: 'fast-indexed-query',
    propertyReadPath: propertyPath,
    candidatePageCount: result.hits.length,
    returnedPageCount: 0,
    queryHitValueCount: 0,
    queryHitValueSources: {},
    fallbackReadCount: 0,
    fallbackValueCount: 0,
    missingValueCount: 0,
    readFailureCount: 0,
    sampleHitKeys: result.hits[0] ? Object.keys(result.hits[0]).slice(0, 12) : undefined,
  };

  const pages: PagePropertyEntry[] = [];

  for (const hit of result.hits) {
    const pagePath = String(hit['jcr:path'] ?? '');
    let propertyRead = extractPropertyWithSource(hit, property);
    if (propertyRead.value !== null) {
      telemetry.queryHitValueCount++;
      if (propertyRead.source) {
        telemetry.queryHitValueSources![propertyRead.source] =
          (telemetry.queryHitValueSources![propertyRead.source] ?? 0) + 1;
      }
    }

    if (propertyRead.value === null && pagePath) {
      telemetry.fallbackReadCount++;
      try {
        const jcrContent = await aemClient.getNode<Record<string, unknown>>(`${pagePath}/jcr:content`);
        propertyRead = {
          value: normalizePropertyValue(jcrContent[property]),
          source: 'fallback-jcr-content',
        };
        if (propertyRead.value !== null) {
          telemetry.fallbackValueCount++;
        }
      } catch (e) {
        telemetry.readFailureCount++;
        logger.warn(`[page-property-report] Could not fallback-read ${property} for ${pagePath}`, e);
      }
    }

    if (propertyRead.value === null) {
      telemetry.missingValueCount++;
      continue;
    }

    pages.push({
      pagePath,
      propertyValue: propertyRead.value,
      isMissing: false,
    });
  }

  telemetry.returnedPageCount = pages.length;
  logger.info('[page-property-report] Fast indexed query completed', telemetry);

  return { pages, telemetry };
}

async function batchedPropertyScan(
  property: string,
  propertyValue: string | undefined,
  reportMissing: boolean,
  rootPath: string,
  maxPages: number,
  ctx?: JobExecutionContext,
): Promise<{ pages: PagePropertyEntry[]; telemetry: PagePropertyReportTelemetry }> {
  // Get all page paths
  const allPages = await queryBuilder.queryAll<{ 'jcr:path': string }>(
    {
      type: 'cq:Page',
      path: rootPath,
      'p.hits': 'selective',
      'p.properties': 'jcr:path',
    },
    maxPages,
  );

  const discoveredPagePaths = allPages.hits.map(h => h['jcr:path']).filter(Boolean) as string[];
  const checkpoint = ctx?.getCheckpoint<{
    pagePaths?: string[];
    results?: PagePropertyEntry[];
    nextBatchIndex?: number;
  }>();
  const pagePaths = checkpoint?.pagePaths ?? discoveredPagePaths;
  const results: PagePropertyEntry[] = checkpoint?.results ?? [];
  const batchSize = 30;
  const startBatchIndex = checkpoint?.nextBatchIndex ?? 0;
  const telemetry: PagePropertyReportTelemetry = {
    strategy: 'batched-property-scan',
    propertyReadPath: `jcr:content/${property}`,
    candidatePageCount: pagePaths.length,
    returnedPageCount: results.length,
    queryHitValueCount: 0,
    fallbackReadCount: 0,
    fallbackValueCount: 0,
    missingValueCount: 0,
    readFailureCount: 0,
    sampleHitKeys: allPages.hits[0] ? Object.keys(allPages.hits[0]).slice(0, 12) : undefined,
  };

  // Process in batches of 30
  for (let i = startBatchIndex * batchSize; i < pagePaths.length; i += batchSize) {
    const batch = pagePaths.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize);
    const totalBatches = Math.ceil(pagePaths.length / batchSize);

    await ctx?.heartbeat({
      checkpoint: { pagePaths, results, nextBatchIndex: batchIndex },
      progressPercent: Math.round((batchIndex / Math.max(totalBatches, 1)) * 100),
      message: `Scanning page batch ${batchIndex + 1}/${totalBatches} for property "${property}".`,
    });

    await Promise.all(batch.map(async (pagePath) => {
      try {
        telemetry.fallbackReadCount++;
        const jcrContent = await aemClient.getNode<Record<string, unknown>>(
          `${pagePath}/jcr:content`,
        );
        const value = jcrContent[property];
        const hasProperty = value !== undefined;
        const valueMatches = propertyValue === undefined || propertyContainsValue(value, propertyValue);

        if (reportMissing && !hasProperty) {
          telemetry.missingValueCount++;
          results.push({ pagePath, propertyValue: null, isMissing: true });
        } else if (!reportMissing && hasProperty && valueMatches) {
          telemetry.fallbackValueCount++;
          results.push({
            pagePath,
            propertyValue: Array.isArray(value) ? value.map(String) : String(value),
            isMissing: false,
          });
        }
      } catch (e) {
        telemetry.readFailureCount++;
        logger.warn(`Could not read jcr:content for ${pagePath}`, e);
      }
    }));

    ctx?.saveCheckpoint({
      pagePaths,
      results,
      nextBatchIndex: batchIndex + 1,
    });

    // Rate limit between batches
    if (i + batchSize < pagePaths.length) {
      await new Promise(r => setTimeout(r, config.query.batchDelayMs));
    }
  }

  telemetry.returnedPageCount = results.length;
  logger.info('[page-property-report] Batched property scan completed', telemetry);

  return { pages: results, telemetry };
}

// ─── MSM detection ─────────────────────────────────────────────────────────────

interface MsmContext {
  isMsmSite: boolean;
  masterPath?: string;
}

async function detectMsmContext(rootPath: string): Promise<MsmContext> {
  try {
    const count = await queryBuilder.count({
      type: 'cq:LiveSyncConfig',
      path: rootPath,
    });

    if (count === 0) return { isMsmSite: false };

    // Try to find the blueprint (master) by looking for a LiveRelationship
    const result = await queryBuilder.query<Record<string, unknown>>(
      {
        type: 'cq:LiveSyncConfig',
        path: rootPath,
        'p.hits': 'selective',
        'p.properties': 'jcr:path cq:master',
      },
      0,
      1,
    );

    const firstHit = result.hits[0];
    const masterPath = firstHit ? String(firstHit['cq:master'] ?? '') : undefined;

    return { isMsmSite: true, masterPath };
  } catch {
    return { isMsmSite: false };
  }
}

function determineEffectivePath(
  rootPath: string,
  scope: string,
  msmContext: MsmContext,
): string {
  if (msmContext.isMsmSite && scope === 'master' && msmContext.masterPath) {
    return trimToMasterRoot(msmContext.masterPath) ?? rootPath;
  }
  return rootPath;
}

/**
 * Trim a JCR path down to the MSM language-master root.
 *
 * The standard AEM MSM layout is:
 *   /content/<project>/(language-masters | <countryCode>)/<languageCode>[/...]
 *
 * Examples:
 *   /content/wknd/language-masters/en/articles/foo  →  /content/wknd/language-masters/en
 *   /content/wknd/us/en/articles/foo                →  /content/wknd/us/en
 *   /content/wknd/de/de                             →  /content/wknd/de/de
 *
 * Country code is matched as a 2-letter lowercase token (ISO 3166-1 alpha-2).
 * Language code is matched the same way (ISO 639-1) — AEM authors sometimes
 * use locale forms like `en_US` so we accept that shape too.
 *
 * Returns `undefined` when the path doesn't match the standard layout. The
 * caller falls back to the original rootPath, which is correct (just possibly
 * wider than ideal) rather than guessing.
 */
export function trimToMasterRoot(masterPath: string): string | undefined {
  const STANDARD_MSM = /^(\/content\/[^/]+\/(?:language-masters|[a-z]{2})\/[a-z]{2}(?:[_-][a-zA-Z]{2,3})?)(?:\/|$)/;
  const match = masterPath.match(STANDARD_MSM);
  return match?.[1];
}

// ─── Property helpers ──────────────────────────────────────────────────────────

const KNOWN_INDEXED = new Set([
  'cq:template', 'jcr:title', 'cq:lastModified', 'cq:lastModifiedBy',
  'jcr:created', 'jcr:createdBy', 'sling:vanityPath',
]);

function isIndexedProperty(property: string): boolean {
  return KNOWN_INDEXED.has(property);
}

function extractPropertyWithSource(
  hit: Record<string, unknown>,
  property: string,
): { value: string | string[] | null; source?: string } {
  const key = `jcr:content/${property}`;
  if (key in hit) {
    return { value: normalizePropertyValue(hit[key]), source: 'query-hit-relative-path' };
  }
  if (property in hit) {
    return { value: normalizePropertyValue(hit[property]), source: 'query-hit-property-name' };
  }

  const jcrContent = hit['jcr:content'];
  if (jcrContent && typeof jcrContent === 'object' && property in jcrContent) {
    return {
      value: normalizePropertyValue((jcrContent as Record<string, unknown>)[property]),
      source: 'query-hit-nested-jcr-content',
    };
  }

  return { value: null };
}

function normalizePropertyValue(val: unknown): string | string[] | null {
  if (val === undefined || val === null) return null;
  if (Array.isArray(val)) return val.map(String);
  return String(val);
}

function propertyContainsValue(value: unknown, expected: string): boolean {
  const normalizedExpected = expected.toLowerCase();

  if (Array.isArray(value)) {
    return value.some(item => String(item).toLowerCase().includes(normalizedExpected));
  }

  return String(value).toLowerCase().includes(normalizedExpected);
}

function supportsScopedFulltext(property: string): boolean {
  return property === 'jcr:title';
}
