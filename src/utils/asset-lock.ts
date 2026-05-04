/**
 * Per-asset, per-process serialisation primitive.
 *
 * Multiple MCP sessions running concurrently in the same server process must
 * not write to the same DAM asset at the same time — race conditions can
 * silently overwrite one author's offTime/onTime change with another's, and
 * AEM's Sling POST has no opportunistic-locking semantics by default.
 *
 * `withAssetLock(path, fn)` serialises calls per `path`:
 *   - First call runs `fn` immediately.
 *   - Subsequent calls for the same path are queued (FIFO) and run only after
 *     the previous holder's promise settles — success or failure.
 *   - Different paths run fully in parallel.
 *
 * Scope and limits:
 *   - In-process only. A multi-replica deployment (Render free tier sleeps but
 *     does not multi-replica, so this is fine for the demo) would need a
 *     Redis / Postgres advisory lock — captured in the README roadmap.
 *   - Locks are not exposed to AEM. AEM's own write commits remain the source
 *     of truth — this layer prevents OUR concurrent writers from clobbering
 *     each other before AEM ever sees them.
 *   - Throws are not absorbed: `fn`'s rejection still rejects the caller, and
 *     the next queued caller proceeds.
 */

import { logger } from './logger.js';

// Map<assetPath, tail-of-queue promise>. The "tail" is the promise that the
// next caller must await before running its own fn. We never read the value
// of the tail promise — only its settlement.
const tails = new Map<string, Promise<unknown>>();

export interface LockedRunResult<T> {
  result: T;
  /** True when the call had to wait for an in-flight holder. */
  waited: boolean;
  /** Wall-clock ms spent waiting in the queue (0 if the lock was free). */
  waitedMs: number;
}

export async function withAssetLock<T>(
  assetPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const { result } = await withAssetLockMeta(assetPath, fn);
  return result;
}

/**
 * Same as `withAssetLock` but exposes wait metrics — useful when callers want
 * to surface "waited Xms for lock" in tool result items.
 */
export async function withAssetLockMeta<T>(
  assetPath: string,
  fn: () => Promise<T>,
): Promise<LockedRunResult<T>> {
  const previous = tails.get(assetPath);
  const waited = previous !== undefined;
  const waitStart = waited ? Date.now() : 0;

  // Run `fn` only AFTER the previous holder settles. We use both branches
  // (success + failure) so a failed holder doesn't block the queue forever.
  const myTurn: Promise<T> = previous
    ? previous.then(() => fn(), () => fn())
    : fn();

  // Atomically (single JS event-loop tick — no awaits between read and write)
  // make our promise the new tail of the queue.
  tails.set(assetPath, myTurn);

  if (waited) {
    logger.debug(`Asset lock: queued for ${assetPath}`);
  }

  try {
    const result = await myTurn;
    return {
      result,
      waited,
      waitedMs: waited ? Date.now() - waitStart : 0,
    };
  } finally {
    // If we're still the tail (no later caller queued behind us), drop the
    // entry so the map doesn't accumulate one entry per asset ever touched.
    // If a later caller has set themselves as the tail, leave it for them.
    if (tails.get(assetPath) === myTurn) {
      tails.delete(assetPath);
    }
  }
}

/** Test-only: number of paths currently with a lock entry. */
export function _activeLockCount(): number {
  return tails.size;
}

/** Test-only: clear all locks. */
export function _resetAssetLocksForTest(): void {
  tails.clear();
}
