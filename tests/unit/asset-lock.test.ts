/**
 * Unit tests for the per-asset lock primitive.
 *
 * The lock guarantees that concurrent calls for the SAME asset path are
 * serialised, while concurrent calls for DIFFERENT paths run in parallel.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  withAssetLock,
  withAssetLockMeta,
  _activeLockCount,
  _resetAssetLocksForTest,
} from '../../src/utils/asset-lock.js';

afterEach(() => {
  _resetAssetLocksForTest();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withAssetLock — same-path serialisation', () => {
  it('queues a second caller until the first releases', async () => {
    const events: string[] = [];

    const first = withAssetLock('/content/dam/a.png', async () => {
      events.push('first:start');
      await sleep(50);
      events.push('first:end');
      return 'A';
    });

    // Start the second caller while the first is mid-flight.
    await sleep(10);
    const second = withAssetLock('/content/dam/a.png', async () => {
      events.push('second:start');
      return 'B';
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('returns each caller\'s value correctly', async () => {
    const a = withAssetLock('/content/dam/x.png', async () => 1);
    const b = withAssetLock('/content/dam/x.png', async () => 2);
    const c = withAssetLock('/content/dam/x.png', async () => 3);
    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(await c).toBe(3);
  });

  it('releases the lock when fn throws — next caller proceeds', async () => {
    const events: string[] = [];

    const first = withAssetLock('/content/dam/a.png', async () => {
      events.push('first:start');
      throw new Error('boom');
    }).catch((e) => `caught:${(e as Error).message}`);

    await sleep(5);
    const second = withAssetLock('/content/dam/a.png', async () => {
      events.push('second:start');
      return 'ok';
    });

    expect(await first).toBe('caught:boom');
    expect(await second).toBe('ok');
    expect(events).toEqual(['first:start', 'second:start']);
  });

  it('serialises a long chain in FIFO order', async () => {
    const order: number[] = [];
    const tasks = Array.from({ length: 5 }, (_, i) =>
      withAssetLock('/content/dam/q.png', async () => {
        await sleep(5);
        order.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('withAssetLock — different paths run in parallel', () => {
  it('does not block calls on different asset paths', async () => {
    const events: string[] = [];

    const a = withAssetLock('/content/dam/a.png', async () => {
      events.push('a:start');
      await sleep(40);
      events.push('a:end');
    });

    const b = withAssetLock('/content/dam/b.png', async () => {
      events.push('b:start');
      await sleep(40);
      events.push('b:end');
    });

    await Promise.all([a, b]);

    // a:start and b:start must both fire before either ends — proves overlap.
    const aStart = events.indexOf('a:start');
    const aEnd = events.indexOf('a:end');
    const bStart = events.indexOf('b:start');
    expect(bStart).toBeGreaterThan(aStart);
    expect(bStart).toBeLessThan(aEnd);
  });
});

describe('withAssetLockMeta — wait metrics', () => {
  it('reports waited=false and waitedMs=0 when the lock is free', async () => {
    const meta = await withAssetLockMeta('/content/dam/free.png', async () => 'ok');
    expect(meta.waited).toBe(false);
    expect(meta.waitedMs).toBe(0);
    expect(meta.result).toBe('ok');
  });

  it('reports waited=true and a positive waitedMs when serialised behind a holder', async () => {
    const first = withAssetLockMeta('/content/dam/busy.png', async () => {
      await sleep(40);
      return 'first';
    });
    await sleep(5);
    const second = withAssetLockMeta('/content/dam/busy.png', async () => 'second');

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.waited).toBe(false);
    expect(r2.waited).toBe(true);
    expect(r2.waitedMs).toBeGreaterThanOrEqual(20);
  });
});

describe('lock map cleanup', () => {
  it('drops the map entry after the last caller releases', async () => {
    expect(_activeLockCount()).toBe(0);
    await withAssetLock('/content/dam/x.png', async () => 'x');
    expect(_activeLockCount()).toBe(0);
  });

  it('keeps an entry while a queue still has waiters', async () => {
    const first = withAssetLock('/content/dam/q.png', async () => {
      await sleep(30);
    });
    await sleep(5);
    const second = withAssetLock('/content/dam/q.png', async () => {
      await sleep(30);
    });

    // While `first` is still in flight and `second` is queued, the entry is alive.
    expect(_activeLockCount()).toBe(1);

    await Promise.all([first, second]);
    expect(_activeLockCount()).toBe(0);
  });
});
