import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/aem-client.js', () => ({
  aemClient: {
    get: vi.fn(),
    post: vi.fn(),
    fetch: vi.fn(),
    pathExists: vi.fn(),
    getNode: vi.fn(),
  },
  AemError: class AemError extends Error {
    statusCode: number;
    url: string;
    constructor(message: string, statusCode: number, url: string) {
      super(message);
      this.name = 'AemError';
      this.statusCode = statusCode;
      this.url = url;
    }
  },
}));

vi.mock('../../src/query-builder.js', () => ({
  queryBuilder: {
    count: vi.fn(),
    query: vi.fn(),
    queryAll: vi.fn(),
  },
}));

vi.mock('../../src/job-manager.js', () => ({
  jobManager: {
    start: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    aem: {
      host: 'http://localhost:4502',
      username: 'admin',
      password: 'admin',
      platform: 'aemaacs',
      instance: 'author',
      contentRoot: '/content',
      damRoot: '/content/dam',
    },
    query: { asyncThreshold: 500, pageSize: 200, batchDelayMs: 0 },
    jobs: {
      ttlMs: 3_600_000,
      healthPollIntervalMs: 15_000,
      healthRetryAfterMs: 30_000,
      degradedLatencyMs: 1_500,
      criticalLatencyMs: 4_000,
      maxHeapPercent: 85,
      maxQueuedJobs: 100,
      maxActiveJobs: 20,
      maxFailedJobs: 10,
    },
    debug: { enabled: false, verbose: false },
  },
}));

import { aemClient, AemError as AemErrorCtor } from '../../src/aem-client.js';
import { queryBuilder } from '../../src/query-builder.js';
import { jobManager } from '../../src/job-manager.js';
import { config } from '../../src/config.js';
import { _resetAssetLocksForTest } from '../../src/utils/asset-lock.js';
import {
  assetExpiryReport,
  extendAssetExpiry,
} from '../../src/tools/asset-expiry.js';

const DAY_MS = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  _resetAssetLocksForTest();
  // Reset instance to author by default
  (config as unknown as { aem: { instance: string } }).aem.instance = 'author';
  vi.mocked(jobManager.start).mockReturnValue({
    jobId: 'job-1',
    message: 'queued',
    checkAfterMs: 1000,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// Author-only enforcement
// ───────────────────────────────────────────────────────────────────────────

describe('author-only guard', () => {
  it('refuses assetExpiryReport when AEM_INSTANCE=publish', async () => {
    (config as unknown as { aem: { instance: string } }).aem.instance = 'publish';
    await expect(assetExpiryReport({ withinDays: 5 })).rejects.toThrow(
      /can only run against an AEM author instance/i,
    );
    expect(queryBuilder.queryAll).not.toHaveBeenCalled();
  });

  it('refuses extendAssetExpiry when AEM_INSTANCE=publish', async () => {
    (config as unknown as { aem: { instance: string } }).aem.instance = 'publish';
    await expect(
      extendAssetExpiry({ assetPaths: ['/content/dam/x.png'], extendByDays: 5 }),
    ).rejects.toThrow(/can only run against an AEM author instance/i);
    expect(aemClient.post).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Report
// ───────────────────────────────────────────────────────────────────────────

describe('aem_asset_expiry_report', () => {
  it('enumerates dam:Asset paths via QueryBuilder and reads offTime via jcr:content fetch (no daterange/exists predicate)', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [],
      total: 0,
      more: false,
    });

    await assetExpiryReport({ withinDays: 5, damPath: '/content/dam/wknd' });

    const call = vi.mocked(queryBuilder.queryAll).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      type: 'dam:Asset',
      path: '/content/dam/wknd',
      'p.hits': 'selective',
      'p.properties': 'jcr:path',
    });
    // Predicate-based filters proved unreliable; we explicitly DO NOT send them.
    expect(call).not.toHaveProperty('daterange.property');
    expect(call).not.toHaveProperty('property');
    expect(call).not.toHaveProperty('property.operation');
  });

  it('matches assets whose offTime is stored as a JS Date.toString() String (regression: real-world AEM data)', async () => {
    // Real value seen on /content/dam/wknd/en/site/wknd-logo-light.png
    const realWorldOffTime = 'Sun May 10 2026 23:33:00 GMT+0530';
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [{ 'jcr:path': '/content/dam/wknd/en/site/wknd-logo-light.png' }],
      total: 1,
      more: false,
    });
    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: realWorldOffTime });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T00:00:00Z'));

    try {
      const result = await assetExpiryReport({ withinDays: 365 });
      expect(aemClient.getNode).toHaveBeenCalledWith(
        '/content/dam/wknd/en/site/wknd-logo-light.png/jcr:content',
      );
      expect(result.totalExpiringCount).toBe(1);
      expect(result.displayedAssets[0]?.assetPath).toBe(
        '/content/dam/wknd/en/site/wknd-logo-light.png',
      );
      expect(result.displayedAssets[0]?.daysUntilExpiry).toBeGreaterThanOrEqual(7);
      expect(result.displayedAssets[0]?.daysUntilExpiry).toBeLessThanOrEqual(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips assets whose offTime is unparsable but does not crash', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/dam/a.png' },
        { 'jcr:path': '/content/dam/b.png' },
      ],
      total: 2,
      more: false,
    });
    vi.mocked(aemClient.getNode)
      .mockResolvedValueOnce({ offTime: 'garbage value' })
      .mockResolvedValueOnce({ offTime: new Date(Date.now() + DAY_MS).toISOString() });

    const result = await assetExpiryReport({ withinDays: 30 });
    expect(result.totalExpiringCount).toBe(1);
    expect(result.displayedAssets[0]?.assetPath).toBe('/content/dam/b.png');
  });

  it('skips assets that have no offTime set at all', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/dam/no-expiry.png' },
        { 'jcr:path': '/content/dam/with-expiry.png' },
      ],
      total: 2,
      more: false,
    });
    vi.mocked(aemClient.getNode)
      .mockResolvedValueOnce({}) // no offTime
      .mockResolvedValueOnce({ offTime: new Date(Date.now() + DAY_MS).toISOString() });

    const result = await assetExpiryReport({ withinDays: 30 });
    expect(result.totalExpiringCount).toBe(1);
    expect(result.displayedAssets[0]?.assetPath).toBe('/content/dam/with-expiry.png');
  });

  it('excludes already-expired assets by default', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/dam/expired.png' },
        { 'jcr:path': '/content/dam/future.png' },
      ],
      total: 2,
      more: false,
    });
    vi.mocked(aemClient.getNode)
      .mockResolvedValueOnce({ offTime: new Date(Date.now() - DAY_MS).toISOString() })
      .mockResolvedValueOnce({ offTime: new Date(Date.now() + DAY_MS).toISOString() });

    const result = await assetExpiryReport({ withinDays: 30 });
    expect(result.displayedAssets.map(a => a.assetPath)).toEqual(['/content/dam/future.png']);
  });

  it('includeExpired=true returns assets whose offTime is already in the past', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/dam/expired.png' },
        { 'jcr:path': '/content/dam/future.png' },
      ],
      total: 2,
      more: false,
    });
    vi.mocked(aemClient.getNode)
      .mockResolvedValueOnce({ offTime: new Date(Date.now() - DAY_MS).toISOString() })
      .mockResolvedValueOnce({ offTime: new Date(Date.now() + DAY_MS).toISOString() });

    const result = await assetExpiryReport({ withinDays: 30, includeExpired: true });
    expect(result.totalExpiringCount).toBe(2);
  });

  it('returns at most 10 assets and reports the total count when more exist', async () => {
    const now = Date.now();
    const hits = Array.from({ length: 25 }, (_, i) => ({
      'jcr:path': `/content/dam/wknd/asset-${i}.png`,
    }));
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits,
      total: 25,
      more: false,
    });
    let counter = 0;
    vi.mocked(aemClient.getNode).mockImplementation(async () => {
      const i = counter++;
      return { offTime: new Date(now + (i + 1) * 1000).toISOString() };
    });

    const result = await assetExpiryReport({ withinDays: 5 });

    expect(result.totalExpiringCount).toBe(25);
    expect(result.displayedCount).toBe(10);
    expect(result.displayedAssets.length).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.recommendations.some(r => /first 10/.test(r))).toBe(true);
  });

  it('sorts by soonest expiry first', async () => {
    const now = Date.now();
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/dam/a.png' },
        { 'jcr:path': '/content/dam/b.png' },
        { 'jcr:path': '/content/dam/c.png' },
      ],
      total: 3,
      more: false,
    });
    const offByPath: Record<string, string> = {
      '/content/dam/a.png/jcr:content': new Date(now + 4 * DAY_MS).toISOString(),
      '/content/dam/b.png/jcr:content': new Date(now + 1 * DAY_MS).toISOString(),
      '/content/dam/c.png/jcr:content': new Date(now + 3 * DAY_MS).toISOString(),
    };
    vi.mocked(aemClient.getNode).mockImplementation(async (p: string) => ({
      offTime: offByPath[p],
    }));

    const result = await assetExpiryReport({ withinDays: 5 });
    expect(result.displayedAssets.map(a => a.assetPath)).toEqual([
      '/content/dam/b.png',
      '/content/dam/c.png',
      '/content/dam/a.png',
    ]);
  });

  it('returns empty result with a clear note when no assets are expiring', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({ hits: [], total: 0, more: false });
    const result = await assetExpiryReport({ withinDays: 5 });
    expect(result.totalExpiringCount).toBe(0);
    expect(result.displayedAssets).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.recommendations[0]).toMatch(/No assets/i);
  });

  it('rejects negative or non-finite withinDays', async () => {
    await expect(assetExpiryReport({ withinDays: -1 })).rejects.toThrow(/non-negative/i);
    await expect(assetExpiryReport({ withinDays: NaN })).rejects.toThrow(/non-negative/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Extend
// ───────────────────────────────────────────────────────────────────────────

describe('aem_extend_asset_expiry — input validation', () => {
  it('requires either assetPaths or withinDays', async () => {
    await expect(extendAssetExpiry({ extendByDays: 5 })).rejects.toThrow(
      /assetPaths.*withinDays/i,
    );
  });

  it('rejects passing both assetPaths and withinDays', async () => {
    await expect(
      extendAssetExpiry({ assetPaths: ['/content/dam/x.png'], withinDays: 5, extendByDays: 3 }),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  it('rejects passing both extendByDays and newOffTime', async () => {
    await expect(
      extendAssetExpiry({
        assetPaths: ['/content/dam/x.png'],
        extendByDays: 5,
        newOffTime: '2026-12-31T00:00:00Z',
      }),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  it('rejects invalid newOffTime', async () => {
    await expect(
      extendAssetExpiry({
        assetPaths: ['/content/dam/x.png'],
        newOffTime: 'not-a-date',
      }),
    ).rejects.toThrow(/not a valid date/i);
  });

  it('rejects invalid newOnTime', async () => {
    await expect(
      extendAssetExpiry({
        assetPaths: ['/content/dam/x.png'],
        newOnTime: 'definitely-not-a-date',
      }),
    ).rejects.toThrow(/newOnTime is not a valid date/i);
  });

  it('rejects when newOnTime is after newOffTime (asset would never be live)', async () => {
    await expect(
      extendAssetExpiry({
        assetPaths: ['/content/dam/x.png'],
        newOnTime: '2026-12-31T00:00:00Z',
        newOffTime: '2026-06-01T00:00:00Z',
      }),
    ).rejects.toThrow(/never be live/i);
  });

  it('requires at least one of extendByDays, newOffTime, or newOnTime', async () => {
    await expect(
      extendAssetExpiry({ assetPaths: ['/content/dam/x.png'] }),
    ).rejects.toThrow(/extendByDays.*newOffTime.*newOnTime/i);
  });

  it('rejects non-positive extendByDays', async () => {
    await expect(
      extendAssetExpiry({ assetPaths: ['/content/dam/x.png'], extendByDays: 0 }),
    ).rejects.toThrow(/positive/i);
  });

  it('drops asset paths outside /content/dam silently', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: '2026-05-10T00:00:00.000Z' });
    vi.mocked(aemClient.post).mockResolvedValue({});

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png', '/etc/secret', '/var/foo'],
      extendByDays: 5,
    })) as Awaited<ReturnType<typeof extendAssetExpiry>> & { processed: number };

    expect('processed' in result && result.processed).toBe(1);
    expect(aemClient.post).toHaveBeenCalledTimes(1);
  });
});

describe('aem_extend_asset_expiry — extension semantics', () => {
  it('adds extendByDays to the existing offTime', async () => {
    const original = '2026-05-10T00:00:00.000Z';
    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: original });
    vi.mocked(aemClient.post).mockResolvedValue({});

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      extendByDays: 7,
    })) as { items: { newOffTime: string | null }[] };

    expect(aemClient.post).toHaveBeenCalledWith(
      '/content/dam/x.png/jcr:content',
      expect.objectContaining({
        'offTime@TypeHint': 'Date',
      }),
    );
    const expected = new Date(new Date(original).getTime() + 7 * DAY_MS).toISOString();
    expect(result.items[0]?.newOffTime).toBe(expected);
  });

  it('uses the current time as the base when the asset has no existing offTime', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({}); // no offTime
    vi.mocked(aemClient.post).mockResolvedValue({});

    const before = Date.now();
    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      extendByDays: 5,
    })) as { items: { previousOffTime: string | null; newOffTime: string | null }[] };
    const after = Date.now();

    expect(result.items[0]?.previousOffTime).toBeNull();
    const newTime = new Date(result.items[0]!.newOffTime!).getTime();
    expect(newTime).toBeGreaterThanOrEqual(before + 5 * DAY_MS - 1000);
    expect(newTime).toBeLessThanOrEqual(after + 5 * DAY_MS + 1000);
  });

  it('honours newOffTime as an absolute replacement', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: '2026-05-10T00:00:00.000Z' });
    vi.mocked(aemClient.post).mockResolvedValue({});

    await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      newOffTime: '2027-01-01T00:00:00Z',
    });

    expect(aemClient.post).toHaveBeenCalledWith(
      '/content/dam/x.png/jcr:content',
      {
        offTime: '2027-01-01T00:00:00.000Z',
        'offTime@TypeHint': 'Date',
      },
    );
  });

  it('dryRun does not call POST and reports status="dry-run"', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: '2026-05-10T00:00:00.000Z' });

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png', '/content/dam/y.png'],
      extendByDays: 3,
      dryRun: true,
    })) as { items: { status: string }[]; updated: number };

    expect(aemClient.post).not.toHaveBeenCalled();
    expect(result.items.every(i => i.status === 'dry-run')).toBe(true);
    expect(result.updated).toBe(2); // dry-run counts toward "would-update"
  });

  it('marks failed items but continues processing the rest of the batch', async () => {
    vi.mocked(aemClient.getNode)
      .mockResolvedValueOnce({ offTime: '2026-05-10T00:00:00.000Z' })
      .mockRejectedValueOnce(new Error('403 forbidden'))
      .mockResolvedValueOnce({ offTime: '2026-05-12T00:00:00.000Z' });
    vi.mocked(aemClient.post).mockResolvedValue({});

    const result = (await extendAssetExpiry({
      assetPaths: [
        '/content/dam/a.png',
        '/content/dam/b.png',
        '/content/dam/c.png',
      ],
      extendByDays: 1,
    })) as { updated: number; failed: number; items: { status: string }[] };

    expect(result.updated).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.items.find(i => i.status === 'failed')).toBeTruthy();
  });
});

describe('aem_extend_asset_expiry — batching and async', () => {
  it('processes updates in batches of `batchSize`', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: '2026-05-10T00:00:00.000Z' });
    vi.mocked(aemClient.post).mockResolvedValue({});

    const paths = Array.from({ length: 7 }, (_, i) => `/content/dam/a${i}.png`);
    await extendAssetExpiry({
      assetPaths: paths,
      extendByDays: 1,
      batchSize: 3,
    });

    expect(aemClient.post).toHaveBeenCalledTimes(7);
  });

  it('dispatches an async job when candidate count exceeds asyncThreshold', async () => {
    const paths = Array.from({ length: 600 }, (_, i) => `/content/dam/a${i}.png`);

    const result = await extendAssetExpiry({
      assetPaths: paths,
      extendByDays: 1,
    });

    expect(jobManager.start).toHaveBeenCalledOnce();
    expect('jobId' in result).toBe(true);
    // Runner not invoked here, so no POSTs yet
    expect(aemClient.post).not.toHaveBeenCalled();
  });

  it('does NOT dispatch async when dryRun=true even on large batches', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: '2026-05-10T00:00:00.000Z' });
    const paths = Array.from({ length: 600 }, (_, i) => `/content/dam/a${i}.png`);

    const result = await extendAssetExpiry({
      assetPaths: paths,
      extendByDays: 1,
      dryRun: true,
    });

    expect(jobManager.start).not.toHaveBeenCalled();
    expect('items' in result && result.items.length).toBe(600);
    expect(aemClient.post).not.toHaveBeenCalled();
  });

  it('when withinDays is given, queries for expiring assets and queues bulk update', async () => {
    const futureIso = new Date(Date.now() + 2 * DAY_MS).toISOString();
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: Array.from({ length: 10 }, (_, i) => ({
        'jcr:path': `/content/dam/x${i}.png`,
      })),
      total: 10,
      more: false,
    });
    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: futureIso });
    vi.mocked(aemClient.post).mockResolvedValue({});

    await extendAssetExpiry({
      withinDays: 5,
      damPath: '/content/dam/wknd',
      extendByDays: 30,
    });

    const queryParams = vi.mocked(queryBuilder.queryAll).mock.calls[0]?.[0];
    expect(queryParams).toMatchObject({
      type: 'dam:Asset',
      path: '/content/dam/wknd',
      'p.hits': 'selective',
      'p.properties': 'jcr:path',
    });
    expect(queryParams).not.toHaveProperty('property');
    expect(aemClient.post).toHaveBeenCalledTimes(10);
  });
});

describe('aem_extend_asset_expiry — concurrent-session locking', () => {
  it('serialises updates to the same asset across concurrent extendAssetExpiry calls', async () => {
    // Simulate two MCP sessions calling extendAssetExpiry on the same asset
    // path at the same time. The per-asset lock must serialise the GET+POST
    // pair so neither session sees a partial write.
    const events: string[] = [];

    vi.mocked(aemClient.getNode).mockImplementation(async () => {
      events.push('GET');
      await new Promise((r) => setTimeout(r, 30));
      return { offTime: '2026-05-10T00:00:00.000Z' };
    });
    vi.mocked(aemClient.post).mockImplementation(async () => {
      events.push('POST');
      return {};
    });

    const session1 = extendAssetExpiry({
      assetPaths: ['/content/dam/contested.png'],
      extendByDays: 5,
    });
    const session2 = extendAssetExpiry({
      assetPaths: ['/content/dam/contested.png'],
      extendByDays: 5,
    });

    await Promise.all([session1, session2]);

    // Two sessions × (1 GET + 1 POST). Critical assertion: GETs and POSTs
    // alternate strictly — no GET sneaks between session 1's GET and POST.
    expect(events).toEqual(['GET', 'POST', 'GET', 'POST']);
  });

  it('does NOT serialise updates to different assets — they run in parallel', async () => {
    const startTimes: Record<string, number> = {};

    vi.mocked(aemClient.getNode).mockImplementation(async (path) => {
      startTimes[path] = Date.now();
      await new Promise((r) => setTimeout(r, 30));
      return {};
    });
    vi.mocked(aemClient.post).mockResolvedValue({});

    await extendAssetExpiry({
      assetPaths: ['/content/dam/a.png', '/content/dam/b.png'],
      newOnTime: '2026-05-20T00:00:00Z',
    });

    // Both should start within ~5ms of each other.
    const aStart = startTimes['/content/dam/a.png/jcr:content']!;
    const bStart = startTimes['/content/dam/b.png/jcr:content']!;
    expect(Math.abs(aStart - bStart)).toBeLessThan(15);
  });

  it('records lockWaitedMs on the second session\'s item when it had to wait', async () => {
    let firstHolderResolve!: () => void;
    const firstHolder = new Promise<void>((r) => { firstHolderResolve = r; });

    let getCallCount = 0;
    vi.mocked(aemClient.getNode).mockImplementation(async () => {
      getCallCount++;
      if (getCallCount === 1) {
        // First call: hold open until the test releases.
        await firstHolder;
      }
      return {};
    });
    vi.mocked(aemClient.post).mockResolvedValue({});

    const session1 = extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      newOnTime: '2026-05-20T00:00:00Z',
    });

    // Tiny wait so session1's getNode is in flight before session2 queues.
    await new Promise((r) => setTimeout(r, 5));

    const session2 = extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      newOnTime: '2026-05-20T00:00:00Z',
    });

    // Wait long enough that session2 accrues real wait time, then release.
    await new Promise((r) => setTimeout(r, 30));
    firstHolderResolve();

    const [r1, r2] = (await Promise.all([session1, session2])) as Array<{
      items: { lockWaitedMs?: number; assetPath: string }[];
    }>;

    expect(r1.items[0]?.lockWaitedMs).toBeUndefined(); // no wait
    expect(r2.items[0]?.lockWaitedMs).toBeGreaterThanOrEqual(20);
  });
});

describe('aem_extend_asset_expiry — checkpoint resume', () => {
  it('resumes from a saved checkpoint instead of re-processing', async () => {
    let capturedRunner:
      | ((ctx: unknown) => Promise<unknown>)
      | undefined;
    vi.mocked(jobManager.start).mockImplementation((_tool, _params, runner) => {
      capturedRunner = runner as typeof capturedRunner;
      return { jobId: 'job-r', message: 'queued', checkAfterMs: 1000 };
    });

    const paths = Array.from({ length: 600 }, (_, i) => `/content/dam/a${i}.png`);
    await extendAssetExpiry({ assetPaths: paths, extendByDays: 1 });
    expect(capturedRunner).toBeDefined();

    vi.mocked(aemClient.getNode).mockResolvedValue({ offTime: '2026-05-10T00:00:00.000Z' });
    vi.mocked(aemClient.post).mockResolvedValue({});

    const previouslyProcessed = Array.from({ length: 500 }, (_, i) => ({
      assetPath: `/content/dam/a${i}.png`,
      previousOnTime: null,
      previousOffTime: '2026-05-10T00:00:00.000Z',
      newOnTime: null,
      newOffTime: '2026-05-11T00:00:00.000Z',
      status: 'updated' as const,
      replicationStatus: 'not-attempted' as const,
    }));

    const fakeCtx = {
      jobId: 'job-r',
      toolName: 'aem_extend_asset_expiry',
      getCheckpoint: () => ({
        phase: 'update' as const,
        items: previouslyProcessed,
        nextUpdateIndex: 500,
      }),
      saveCheckpoint: vi.fn(),
      setProgress: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue(undefined),
    };

    const result = (await capturedRunner!(fakeCtx)) as { processed: number };

    // Only the remaining 100 should be POSTed
    expect(aemClient.post).toHaveBeenCalledTimes(100);
    expect(result.processed).toBe(600);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// onTime support
// ───────────────────────────────────────────────────────────────────────────

describe('aem_extend_asset_expiry — onTime support', () => {
  it('sets onTime even when the asset has no existing onTime/offTime', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({}); // bare jcr:content
    vi.mocked(aemClient.post).mockResolvedValue({});

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/new-asset.png'],
      newOnTime: '2026-05-20T00:00:00Z',
    })) as {
      items: {
        previousOnTime: string | null;
        previousOffTime: string | null;
        newOnTime: string | null;
        newOffTime: string | null;
        status: string;
      }[];
    };

    expect(aemClient.post).toHaveBeenCalledWith(
      '/content/dam/new-asset.png/jcr:content',
      {
        onTime: '2026-05-20T00:00:00.000Z',
        'onTime@TypeHint': 'Date',
      },
    );
    expect(result.items[0]).toMatchObject({
      previousOnTime: null,
      previousOffTime: null,
      newOnTime: '2026-05-20T00:00:00.000Z',
      newOffTime: null,
      status: 'updated',
    });
  });

  it('sets both onTime and offTime in a single Sling POST when both are provided', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({});
    vi.mocked(aemClient.post).mockResolvedValue({});

    await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      newOnTime: '2026-05-20T00:00:00Z',
      newOffTime: '2026-12-31T23:59:59Z',
    });

    expect(aemClient.post).toHaveBeenCalledWith(
      '/content/dam/x.png/jcr:content',
      {
        onTime: '2026-05-20T00:00:00.000Z',
        'onTime@TypeHint': 'Date',
        offTime: '2026-12-31T23:59:59.000Z',
        'offTime@TypeHint': 'Date',
      },
    );
  });

  it('rejects per-asset when newOnTime is after the asset\'s existing offTime', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({
      offTime: '2026-06-01T00:00:00.000Z',
    });

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      newOnTime: '2026-12-01T00:00:00Z',
    })) as { items: { status: string; error?: string }[]; failed: number };

    expect(result.failed).toBe(1);
    expect(result.items[0]?.status).toBe('failed');
    expect(result.items[0]?.error).toMatch(/after the asset's existing offTime/i);
    expect(aemClient.post).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Publish (replication) phase
// ───────────────────────────────────────────────────────────────────────────

describe('aem_extend_asset_expiry — publish phase', () => {
  it('does NOT replicate by default (publish=false)', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({});
    vi.mocked(aemClient.post).mockResolvedValue({});

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      newOnTime: '2026-05-20T00:00:00Z',
    })) as { publishRequested: boolean; replicated: number; recommendations: string[] };

    expect(result.publishRequested).toBe(false);
    expect(result.replicated).toBe(0);
    // Only the property update POST — no /bin/replicate.json
    expect(aemClient.post).toHaveBeenCalledTimes(1);
    expect(aemClient.post).not.toHaveBeenCalledWith(
      '/bin/replicate.json',
      expect.anything(),
    );
    expect(result.recommendations.some(r => /publish=true/.test(r))).toBe(true);
  });

  it('replicates each successfully updated asset when publish=true', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({});
    vi.mocked(aemClient.post).mockResolvedValue({});

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/a.png', '/content/dam/b.png'],
      newOnTime: '2026-05-20T00:00:00Z',
      publish: true,
    })) as { replicated: number; replicationFailed: number; publishRequested: boolean };

    expect(result.publishRequested).toBe(true);
    expect(result.replicated).toBe(2);
    expect(result.replicationFailed).toBe(0);
    expect(aemClient.post).toHaveBeenCalledWith('/bin/replicate.json', {
      path: '/content/dam/a.png',
      cmd: 'Activate',
    });
    expect(aemClient.post).toHaveBeenCalledWith('/bin/replicate.json', {
      path: '/content/dam/b.png',
      cmd: 'Activate',
    });
  });

  it('does NOT replicate assets whose property update failed', async () => {
    vi.mocked(aemClient.getNode)
      .mockRejectedValueOnce(new Error('403 forbidden')) // asset a fails to read
      .mockResolvedValueOnce({}); // asset b succeeds
    vi.mocked(aemClient.post).mockResolvedValue({});

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/a.png', '/content/dam/b.png'],
      newOnTime: '2026-05-20T00:00:00Z',
      publish: true,
    })) as { updated: number; failed: number; replicated: number };

    // Only asset b's update + replication should hit POST.
    const replicateCalls = vi.mocked(aemClient.post).mock.calls.filter(
      ([url]) => url === '/bin/replicate.json',
    );
    expect(replicateCalls).toHaveLength(1);
    expect(replicateCalls[0]?.[1]).toEqual({
      path: '/content/dam/b.png',
      cmd: 'Activate',
    });
    expect(result.replicated).toBe(1);
  });

  it('reports failed replications back to the user with the failed paths', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({});
    // First call (property update on a): success
    // Second call (property update on b): success
    // Third call (replicate a): fail
    // Fourth call (replicate b): success
    let postCount = 0;
    vi.mocked(aemClient.post).mockImplementation(async (url) => {
      postCount++;
      if (url === '/bin/replicate.json' && postCount === 3) {
        throw new AemErrorCtor('AEM 503 on /bin/replicate.json', 503, '/bin/replicate.json');
      }
      return {};
    });

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/a.png', '/content/dam/b.png'],
      newOnTime: '2026-05-20T00:00:00Z',
      publish: true,
    })) as {
      replicated: number;
      replicationFailed: number;
      failedReplicationPaths: string[];
      items: { assetPath: string; replicationStatus: string; replicationError?: string }[];
      recommendations: string[];
    };

    expect(result.replicated).toBe(1);
    expect(result.replicationFailed).toBe(1);
    expect(result.failedReplicationPaths).toEqual(['/content/dam/a.png']);
    const failedItem = result.items.find(i => i.assetPath === '/content/dam/a.png')!;
    expect(failedItem.replicationStatus).toBe('failed');
    expect(failedItem.replicationError).toMatch(/503/);
    expect(result.recommendations.some(r => /failed to replicate/i.test(r))).toBe(true);
  });

  it('dryRun=true skips both property writes and replication even with publish=true', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({});

    const result = (await extendAssetExpiry({
      assetPaths: ['/content/dam/x.png'],
      newOnTime: '2026-05-20T00:00:00Z',
      publish: true,
      dryRun: true,
    })) as { dryRun: boolean; replicated: number; recommendations: string[] };

    expect(aemClient.post).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.replicated).toBe(0);
    expect(result.recommendations.some(r => /Publish step is also skipped/i.test(r))).toBe(true);
  });

  it('replication phase is batched and paced (uses batchSize)', async () => {
    vi.mocked(aemClient.getNode).mockResolvedValue({});
    vi.mocked(aemClient.post).mockResolvedValue({});

    const paths = Array.from({ length: 10 }, (_, i) => `/content/dam/x${i}.png`);
    await extendAssetExpiry({
      assetPaths: paths,
      newOnTime: '2026-05-20T00:00:00Z',
      publish: true,
      batchSize: 3,
    });

    const replicateCalls = vi.mocked(aemClient.post).mock.calls.filter(
      ([url]) => url === '/bin/replicate.json',
    );
    expect(replicateCalls).toHaveLength(10);
  });
});
