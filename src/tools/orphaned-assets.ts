import { queryBuilder } from '../query-builder.js';
import { aemClient } from '../aem-client.js';
import { jobManager, JobExecutionContext, JobStartResult } from '../job-manager.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface OrphanedAssetsInput {
  damPath?: string;
  contentPath?: string;
  maxAssets?: number;
}

export interface OrphanedAsset {
  assetPath: string;
  mimeType?: string;
  size?: number;
  lastModified?: string;
}

export interface OrphanedAssetsResult {
  damPath: string;
  totalAssetsChecked: number;
  orphanedCount: number;
  orphanedAssets: OrphanedAsset[];
  totalOrphanedSizeMb: number;
  recommendations: string[];
  note: string;
}

const REFERENCE_PROPERTIES = [
  'fileReference',
  'dam:assetReference',
  'backgroundImage',
  'heroImage',
  'image',
  'videoReference',
  'assetReference',
  'logoImage',
];

export async function orphanedAssets(
  input: OrphanedAssetsInput,
): Promise<JobStartResult> {
  const { damPath = config.aem.damRoot, contentPath = config.aem.contentRoot, maxAssets = 5000 } = input;

  const assetCount = Math.min(
    await queryBuilder.count({ type: 'dam:Asset', path: damPath }),
    maxAssets,
  );

  const estimatedMs = assetCount * 100 + 30_000;

  return jobManager.start(
    'aem_orphaned_assets',
    { damPath, contentPath, maxAssets },
    (ctx) => runOrphanedAssets(damPath, contentPath, maxAssets, ctx),
    estimatedMs,
  );
}

async function runOrphanedAssets(
  damPath: string,
  contentPath: string,
  maxAssets: number,
  ctx?: JobExecutionContext,
): Promise<OrphanedAssetsResult> {
  logger.info('Orphaned assets: collecting referenced DAM paths from pages...');
  const referencedPaths = await collectReferencedAssets(contentPath, ctx);
  logger.info(`Orphaned assets: found ${referencedPaths.size} unique asset references`);

  logger.info(`Orphaned assets: fetching all dam:Asset nodes under ${damPath}...`);
  const assetsResult = await queryBuilder.queryAll<Record<string, string>>(
    {
      type: 'dam:Asset',
      path: damPath,
      'p.hits': 'selective',
      'p.properties': 'jcr:path jcr:created dam:assetLastModified',
    },
    maxAssets,
  );

  const checkpoint = ctx?.getCheckpoint<{
    phase?: 'collect-refs' | 'diff-assets';
    orphaned?: OrphanedAsset[];
    nextAssetIndex?: number;
    referencedPaths?: string[];
  }>();
  const orphaned: OrphanedAsset[] = checkpoint?.phase === 'diff-assets'
    ? (checkpoint.orphaned ?? [])
    : [];
  const startAssetIndex = checkpoint?.phase === 'diff-assets'
    ? (checkpoint.nextAssetIndex ?? 0)
    : 0;

  for (let index = startAssetIndex; index < assetsResult.hits.length; index++) {
    const hit = assetsResult.hits[index];
    const assetPath = hit['jcr:path'];
    if (!assetPath) continue;

    await ctx?.heartbeat({
      checkpoint: {
        phase: 'diff-assets',
        orphaned,
        nextAssetIndex: index,
        referencedPaths: [...referencedPaths],
      },
      progressPercent: 50 + Math.round((index / Math.max(assetsResult.hits.length, 1)) * 50),
      message: `Diffing asset ${index + 1}/${assetsResult.hits.length} against collected references.`,
    });

    if (!referencedPaths.has(assetPath)) {
      let mimeType: string | undefined;
      let size: number | undefined;
      try {
        const meta = await aemClient.getNode<Record<string, unknown>>(
          `${assetPath}/jcr:content/metadata`,
        );
        mimeType = meta['dc:format'] as string | undefined;
        size = meta['dam:size'] as number | undefined;
      } catch {
        // metadata fetch is best-effort
      }

      orphaned.push({
        assetPath,
        mimeType,
        size,
        lastModified: hit['dam:assetLastModified'] || hit['jcr:created'],
      });
    }

    ctx?.saveCheckpoint({
      phase: 'diff-assets',
      orphaned,
      nextAssetIndex: index + 1,
      referencedPaths: [...referencedPaths],
    });
  }

  const totalSizeBytes = orphaned.reduce((sum, a) => sum + (a.size ?? 0), 0);
  const totalOrphanedSizeMb = Math.round((totalSizeBytes / 1_048_576) * 100) / 100;

  const recommendations: string[] = [];
  if (orphaned.length > 0) {
    recommendations.push(
      `Found ${orphaned.length} orphaned asset(s) consuming ~${totalOrphanedSizeMb}MB. ` +
      'Review before deleting — assets may be referenced from Experience Fragments, Content Fragments, or external systems not scanned.',
    );
    recommendations.push(
      'To delete assets safely, use the AEM Reference Check before removing each asset from the DAM.',
    );
  } else {
    recommendations.push('No orphaned assets found under the scanned paths.');
  }

  return {
    damPath,
    totalAssetsChecked: assetsResult.hits.length,
    orphanedCount: orphaned.length,
    orphanedAssets: orphaned,
    totalOrphanedSizeMb,
    recommendations,
    note:
      'This scan checks references from cq:Page jcr:content only. ' +
      'References from Experience Fragments, Content Fragments, email templates, or external systems are NOT included.',
  };
}

async function collectReferencedAssets(contentPath: string, ctx?: JobExecutionContext): Promise<Set<string>> {
  const checkpoint = ctx?.getCheckpoint<{
    phase?: 'collect-refs' | 'diff-assets';
    referencedPaths?: string[];
    nextPageBatchIndex?: number;
  }>();

  const referenced = new Set<string>(
    checkpoint?.phase === 'collect-refs' ? (checkpoint.referencedPaths ?? []) : [],
  );

  const pages = await queryBuilder.queryAll<{ 'jcr:path': string }>(
    {
      type: 'cq:Page',
      path: contentPath,
      'p.hits': 'selective',
      'p.properties': 'jcr:path',
    },
    20_000,
  );

  const pagePaths = pages.hits.map(h => h['jcr:path']).filter(Boolean);
  const batchSize = 30;
  const startBatchIndex = checkpoint?.phase === 'collect-refs'
    ? (checkpoint.nextPageBatchIndex ?? 0)
    : 0;

  for (let i = startBatchIndex * batchSize; i < pagePaths.length; i += batchSize) {
    const batch = pagePaths.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize);
    const totalBatches = Math.ceil(pagePaths.length / batchSize);

    await ctx?.heartbeat({
      checkpoint: {
        phase: 'collect-refs',
        referencedPaths: [...referenced],
        nextPageBatchIndex: batchIndex,
      },
      progressPercent: Math.round((batchIndex / Math.max(totalBatches, 1)) * 50),
      message: `Scanning page batch ${batchIndex + 1}/${totalBatches} for DAM references.`,
    });

    await Promise.all(batch.map(async (pagePath) => {
      try {
        const content = await aemClient.getNode<Record<string, unknown>>(
          `${pagePath}/jcr:content`,
          10,
        );
        collectRefsFromNode(content, referenced);
      } catch {
        // non-fatal
      }
    }));

    ctx?.saveCheckpoint({
      phase: 'collect-refs',
      referencedPaths: [...referenced],
      nextPageBatchIndex: batchIndex + 1,
    });

    if (i + batchSize < pagePaths.length) {
      await new Promise(r => setTimeout(r, config.query.batchDelayMs));
    }
  }

  return referenced;
}

function collectRefsFromNode(
  node: Record<string, unknown>,
  accumulator: Set<string>,
): void {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (REFERENCE_PROPERTIES.includes(key) && value.startsWith('/content/dam')) {
        accumulator.add(value.split('?')[0].split('#')[0]);
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      collectRefsFromNode(value as Record<string, unknown>, accumulator);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.startsWith('/content/dam')) {
          accumulator.add(item.split('?')[0].split('#')[0]);
        }
      }
    }
  }
}
