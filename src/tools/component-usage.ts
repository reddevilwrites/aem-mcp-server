import { queryBuilder } from '../query-builder.js';
import { jobManager, JobStartResult } from '../job-manager.js';
import { config } from '../config.js';
import { extractPagePath } from '../utils/path-utils.js';

export interface ComponentUsageInput {
  resourceType: string;        // e.g. "mysite/components/hero" or "core/wcm/components/text/v2/text"
  searchPath?: string;         // default: AEM_CONTENT_ROOT
  /** If result count may exceed threshold, force async */
  async?: boolean;
}

export interface ComponentUsagePage {
  pagePath: string;
  componentPaths: string[];    // all nodes of this type within the page
}

export interface ComponentUsageResult {
  resourceType: string;
  searchPath: string;
  totalComponentNodes: number;
  uniquePageCount: number;
  pages: ComponentUsagePage[];
  indexWarning?: string;
  truncated: boolean;
}

/**
 * Find all pages that contain a specific component (by sling:resourceType).
 *
 * Uses the `slingResourceType` Oak index — this query is index-safe.
 * For very large sites (> AEM_QUERY_ASYNC_THRESHOLD results) the work is
 * dispatched as an async job and a job ID is returned immediately.
 */
export async function componentUsage(
  input: ComponentUsageInput,
): Promise<ComponentUsageResult | JobStartResult> {
  const { resourceType, searchPath = config.aem.contentRoot } = input;

  // Quick count first to decide sync vs async
  const total = await queryBuilder.count({
    type: 'nt:base',
    path: searchPath,
    property: 'sling:resourceType',
    'property.value': resourceType,
  });

  const isLarge = total > config.query.asyncThreshold;

  if (isLarge || input.async) {
    return jobManager.start(
      'aem_component_usage',
      { resourceType, searchPath },
      () => runComponentUsage(resourceType, searchPath),
      estimateDuration(total),
    );
  }

  return runComponentUsage(resourceType, searchPath);
}

async function runComponentUsage(
  resourceType: string,
  searchPath: string,
): Promise<ComponentUsageResult> {
  const result = await queryBuilder.queryAll<{ 'jcr:path': string }>(
    {
      type: 'nt:base',
      path: searchPath,
      property: 'sling:resourceType',
      'property.value': resourceType,
      'p.hits': 'selective',
      'p.properties': 'jcr:path',
    },
    10_000,
  );

  // Group component nodes by their containing page
  const pageMap = new Map<string, string[]>();
  for (const hit of result.hits) {
    const nodePath = hit['jcr:path'] as string;
    if (!nodePath) continue;
    const pagePath = extractPagePath(nodePath);
    if (!pageMap.has(pagePath)) pageMap.set(pagePath, []);
    pageMap.get(pagePath)!.push(nodePath);
  }

  const pages: ComponentUsagePage[] = Array.from(pageMap.entries()).map(
    ([pagePath, componentPaths]) => ({ pagePath, componentPaths }),
  );

  return {
    resourceType,
    searchPath,
    totalComponentNodes: result.hits.length,
    uniquePageCount: pages.length,
    pages,
    indexWarning: result.indexWarning,
    truncated: result.more,
  };
}

function estimateDuration(total: number): number {
  // ~50ms per 100 results for fetching + processing
  return Math.max(10_000, Math.ceil(total / 100) * 50);
}
