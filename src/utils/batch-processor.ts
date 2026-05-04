import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Process items in sequential batches with a configurable delay between batches.
 * Prevents overloading AEM with too many concurrent requests.
 */
export async function processBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (batch: T[], batchIndex: number) => Promise<R[]>,
  delayMs: number = config.query.batchDelayMs,
  hooks?: {
    beforeBatch?: (batch: T[], batchIndex: number, totalBatches: number) => Promise<void>;
    afterBatch?: (batchResults: R[], batchIndex: number, totalBatches: number) => Promise<void>;
  },
): Promise<R[]> {
  const results: R[] = [];
  const totalBatches = Math.ceil(items.length / batchSize);

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize);
    logger.debug(`Processing batch ${batchIndex + 1}/${totalBatches} (${batch.length} items)`);

    if (hooks?.beforeBatch) {
      await hooks.beforeBatch(batch, batchIndex, totalBatches);
    }

    const batchResults = await processor(batch, batchIndex);
    results.push(...batchResults);

    if (hooks?.afterBatch) {
      await hooks.afterBatch(batchResults, batchIndex, totalBatches);
    }

    // Rate-limit: pause between batches (except last)
    if (i + batchSize < items.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Chunk an array into fixed-size sub-arrays */
export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
