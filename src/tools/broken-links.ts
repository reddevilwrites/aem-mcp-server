import { queryBuilder } from '../query-builder.js';
import { aemClient } from '../aem-client.js';
import { jobManager, JobExecutionContext, JobStartResult } from '../job-manager.js';
import { config } from '../config.js';
import { processBatches } from '../utils/batch-processor.js';
import { isInternalPath } from '../utils/path-utils.js';
import { logger } from '../utils/logger.js';

export interface BrokenLinksInput {
  rootPath: string;       // e.g. /content/mysite/en
  /** Properties to inspect for internal links (defaults cover most AEM use cases) */
  linkProperties?: string[];
  /** Max pages to scan (default: 2000) */
  maxPages?: number;
}

export interface BrokenLink {
  pagePath: string;
  componentPath: string;
  property: string;
  brokenTarget: string;
}

export interface BrokenLinksResult {
  rootPath: string;
  pagesScanned: number;
  brokenLinks: BrokenLink[];
  brokenLinkCount: number;
  recommendations: string[];
  note: string;
}

/**
 * Default set of properties commonly used for internal links in AEM components.
 * Extend this list per project needs.
 */
const DEFAULT_LINK_PROPERTIES = [
  'linkURL',
  'fileReference',
  'ctaLink',
  'link',
  'actionLink',
  'heroLink',
  'bannerLink',
  'navigationRoot',
  'redirect',
  'redirectTarget',
];

/**
 * Scan all pages under rootPath for broken internal links.
 *
 * Strategy (index-safe):
 *  1. Use QueryBuilder (type=cq:Page) to get all page paths — uses nodetype index.
 *  2. For each page, fetch jcr:content subtree and extract link properties.
 *  3. For each internal link, verify target existence via HEAD request.
 *  4. Pages are processed in batches of 25 to avoid memory/network pressure.
 *
 * Always runs as an async job due to the inherent I/O volume.
 */
export async function brokenLinkScan(
  input: BrokenLinksInput,
): Promise<JobStartResult> {
  const { rootPath, linkProperties = DEFAULT_LINK_PROPERTIES, maxPages = 2000 } = input;

  // Estimate page count for job duration estimate
  const pageCount = Math.min(
    await queryBuilder.count({ type: 'cq:Page', path: rootPath }),
    maxPages,
  );

  const estimatedMs = pageCount * 150; // ~150ms per page

  return jobManager.start(
    'aem_broken_link_scan',
    { rootPath, linkProperties, maxPages },
    (ctx) => runBrokenLinkScan(rootPath, linkProperties, maxPages, ctx),
    estimatedMs,
  );
}

async function runBrokenLinkScan(
  rootPath: string,
  linkProperties: string[],
  maxPages: number,
  ctx?: JobExecutionContext,
): Promise<BrokenLinksResult> {
  // Step 1: Get all page paths (index-safe: type=cq:Page uses nodetype index)
  const pagesResult = await queryBuilder.queryAll<{ 'jcr:path': string }>(
    {
      type: 'cq:Page',
      path: rootPath,
      'p.hits': 'selective',
      'p.properties': 'jcr:path',
    },
    maxPages,
  );

  const pagePaths = pagesResult.hits
    .map(h => h['jcr:path'])
    .filter(Boolean) as string[];

  logger.info(`Broken link scan: scanning ${pagePaths.length} pages under ${rootPath}`);

  // Step 2: Process pages in batches of 25
  const checkpoint = ctx?.getCheckpoint<{
    pagePaths?: string[];
    brokenLinks?: BrokenLink[];
    nextBatchIndex?: number;
  }>();
  const effectivePagePaths = checkpoint?.pagePaths ?? pagePaths;
  const brokenLinks: BrokenLink[] = checkpoint?.brokenLinks ?? [];
  const existenceCache = new Map<string, boolean>(); // cache to avoid re-checking same target
  const batchSize = 25;
  const startBatchIndex = checkpoint?.nextBatchIndex ?? 0;
  const startOffset = startBatchIndex * batchSize;

  await processBatches(effectivePagePaths.slice(startOffset), batchSize, async (batch, relativeBatchIndex) => {
    const results: BrokenLink[] = [];
    const batchIndex = startBatchIndex + relativeBatchIndex;

    await Promise.all(batch.map(async (pagePath) => {
      try {
        // Fetch jcr:content with depth 10 to cover nested components
        const content = await aemClient.getNode<Record<string, unknown>>(
          `${pagePath}/jcr:content`,
          10,
        );

        const links = extractLinks(pagePath, content, linkProperties);

        for (const link of links) {
          if (!isInternalPath(link.target)) continue;

          // Check cache first
          let exists: boolean | undefined = existenceCache.get(link.target);
          if (exists === undefined) {
            exists = await aemClient.pathExists(link.target);
            existenceCache.set(link.target, exists);
          }

          if (exists === false) {
            results.push({
              pagePath,
              componentPath: link.componentPath,
              property: link.property,
              brokenTarget: link.target,
            });
          }
        }
      } catch (e) {
        logger.warn(`Could not scan page: ${pagePath}`, e);
      }
    }));

    brokenLinks.push(...results);
    ctx?.saveCheckpoint({
      pagePaths: effectivePagePaths,
      brokenLinks,
      nextBatchIndex: batchIndex + 1,
    });
    return results;
  }, config.query.batchDelayMs, {
    beforeBatch: async (_batch, relativeBatchIndex, totalBatches) => {
      const completedBatches = startBatchIndex + relativeBatchIndex;
      const progressPercent = Math.round((completedBatches / (startBatchIndex + totalBatches)) * 100);
      await ctx?.heartbeat({
        checkpoint: {
          pagePaths: effectivePagePaths,
          brokenLinks,
          nextBatchIndex: completedBatches,
        },
        progressPercent,
        message: `Scanning page batch ${completedBatches + 1}/${startBatchIndex + totalBatches} for broken links.`,
      });
    },
    afterBatch: async () => {
      await ctx?.heartbeat();
    },
  });

  const recommendations: string[] = [];
  if (brokenLinks.length > 0) {
    recommendations.push(
      `Found ${brokenLinks.length} broken internal link(s) across ${pagePaths.length} pages. ` +
      `Fix or remove these references to prevent 404 errors and improve content quality.`,
    );
    // Group by broken target for easier fix
    const byTarget = new Map<string, number>();
    for (const b of brokenLinks) {
      byTarget.set(b.brokenTarget, (byTarget.get(b.brokenTarget) ?? 0) + 1);
    }
    const topBroken = [...byTarget.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [target, count] of topBroken) {
      recommendations.push(`"${target}" is referenced ${count} time(s) but does not exist.`);
    }
  } else {
    recommendations.push('No broken internal links found.');
  }

  return {
    rootPath,
    pagesScanned: pagePaths.length,
    brokenLinks,
    brokenLinkCount: brokenLinks.length,
    recommendations,
    note: 'This scan checks internal JCR paths only. External URLs are not validated.',
  };
}

// ─── Link extraction ───────────────────────────────────────────────────────────

interface ExtractedLink {
  componentPath: string;
  property: string;
  target: string;
}

function extractLinks(
  pagePath: string,
  node: Record<string, unknown>,
  properties: string[],
  currentPath = `${pagePath}/jcr:content`,
): ExtractedLink[] {
  const links: ExtractedLink[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('jcr:') && key !== 'jcr:content') continue;

    if (typeof value === 'string' && properties.includes(key)) {
      links.push({ componentPath: currentPath, property: key, target: value });
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recurse into child nodes
      links.push(
        ...extractLinks(pagePath, value as Record<string, unknown>, properties, `${currentPath}/${key}`),
      );
    }
  }

  return links;
}
