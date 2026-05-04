/**
 * Production-safety tests for aem_page_property_report.
 *
 * These tests document and enforce the behaviour the tool must exhibit before
 * it can be considered production-safe on both AEMaaCS and AEM 6.5 / AMS.
 *
 * Sections:
 *  1. Async dispatch thresholds and maxPages enforcement
 *  2. Oak traversal limit (100,000 node hard cap)
 *  3. AEMaaCS-specific restrictions (no inline index deploy, publish lacks
 *     explain servlet, tighter request budgets)
 *  4. Pre-execution explain-plan validation (currently NOT implemented —
 *     marked with `it.todo` so the gap is visible in test output)
 *  5. Cancellation, checkpoint, and health-pause behaviour
 *  6. Input validation and adversarial edge cases
 *
 * Tests in section (4) intentionally describe behaviour the tool does not yet
 * have. They serve as the executable spec for a follow-up hardening pass.
 */

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
    explainQuery: vi.fn(),
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
      contentRoot: '/content',
      damRoot: '/content/dam',
    },
    query: {
      asyncThreshold: 500,
      pageSize: 200,
      batchDelayMs: 0,
    },
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

import { aemClient } from '../../src/aem-client.js';
import { queryBuilder } from '../../src/query-builder.js';
import { jobManager } from '../../src/job-manager.js';
import { pagePropertyReport } from '../../src/tools/page-property-report.js';

const ASYNC_THRESHOLD = 500;
const OAK_TRAVERSAL_LIMIT = 100_000;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a small site, no MSM
  vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
    if (params['type'] === 'cq:LiveSyncConfig') return 0;
    return 10;
  });
  vi.mocked(queryBuilder.query).mockResolvedValue({ hits: [], total: 0, more: false });
  vi.mocked(queryBuilder.queryAll).mockResolvedValue({ hits: [], total: 0, more: false });
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
// 1. Async dispatch thresholds and maxPages enforcement
// ───────────────────────────────────────────────────────────────────────────

describe('async dispatch thresholds', () => {
  it('runs synchronously when page count is at or below the async threshold', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return ASYNC_THRESHOLD; // exactly at threshold → still sync per `>` check
    });
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({ hits: [], total: 0, more: false });

    const result = await pagePropertyReport({ property: 'cq:template', rootPath: '/content/wknd' });
    expect(jobManager.start).not.toHaveBeenCalled();
    expect('pages' in result).toBe(true);
  });

  it('dispatches async when page count exceeds the threshold', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return ASYNC_THRESHOLD + 1;
    });

    const result = await pagePropertyReport({ property: 'cq:template', rootPath: '/content/wknd' });
    expect(jobManager.start).toHaveBeenCalledOnce();
    expect('jobId' in result && result.jobId).toBe('job-1');
  });

  it('honours an explicit async=true even on small sites', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 5;
    });

    await pagePropertyReport({ property: 'cq:template', rootPath: '/content/wknd', async: true });
    expect(jobManager.start).toHaveBeenCalledOnce();
  });

  it('caps the scan at maxPages even when more pages exist', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 10_000;
    });
    vi.mocked(jobManager.start).mockImplementation((_tool, _params, _runner) => {
      // The runner is invoked later by the manager — capture maxPages contract via params.
      expect(_params).toMatchObject({ maxPages: 2_500 });
      return { jobId: 'job-cap', message: 'queued', checkAfterMs: 1000 };
    });

    await pagePropertyReport({
      property: 'cq:template',
      rootPath: '/content/wknd',
      maxPages: 2_500, // > asyncThreshold so dispatch is async
    });
    expect(jobManager.start).toHaveBeenCalledOnce();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Oak 100,000-node traversal limit
// ───────────────────────────────────────────────────────────────────────────

describe('Oak traversal limit (100,000 nodes)', () => {
  it('still dispatches async — but the count itself succeeded — when total pages = 99,999', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return OAK_TRAVERSAL_LIMIT - 1;
    });

    await pagePropertyReport({ property: 'cq:template', rootPath: '/content' });
    expect(jobManager.start).toHaveBeenCalledOnce();
  });

  it('propagates the AEM error if the count query itself triggers the Oak traversal cap', async () => {
    // Real-world: counting cq:Page under /content with no covering index → Oak
    // throws "The query read more than 100000 nodes" (OAK-7960). The tool must
    // NOT swallow this — it must surface a clear error so the caller knows the
    // chosen rootPath/property is unsafe.
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      throw new Error('The query read more than 100000 nodes in memory.');
    });

    await expect(
      pagePropertyReport({ property: 'cq:template', rootPath: '/content' }),
    ).rejects.toThrow(/100000 nodes/);
  });

  it.todo(
    'BREAKING-POINT: when total pages > Oak traversal limit, the tool should ' +
      'refuse to run and recommend either narrowing rootPath or adding an index. ' +
      'Currently the tool calls queryBuilder.count() with no fallback — if that ' +
      'count itself exceeds 100k, AEM aborts the request. The tool should detect ' +
      'this and fail fast with an actionable message instead of letting the ' +
      'underlying HTTP error bubble up.',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 3. AEMaaCS-specific restrictions
// ───────────────────────────────────────────────────────────────────────────

describe('AEMaaCS production constraints', () => {
  it('warns that custom indexes for unindexed properties require an AEMaaCS deployment', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 5;
    });
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [{ 'jcr:path': '/content/wknd/en' }],
      total: 1,
      more: false,
    });
    vi.mocked(aemClient.getNode).mockResolvedValue({});

    const result = await pagePropertyReport({
      property: 'myCustomProp',
      rootPath: '/content/wknd',
    });

    expect('indexWarning' in result && result.indexWarning).toMatch(
      /not in the known Oak index/i,
    );
    // Production-grade: the warning surface should mention that AEMaaCS
    // requires a deploy for index changes — currently it does not.
    // This assertion documents the gap.
    // expect(result.indexWarning).toMatch(/AEMaaCS.*deploy/i);
  });

  it.todo(
    'On AEMaaCS publish tier the explain servlet is not accessible. ' +
      'When platform=aemaacs and the call targets publish, the tool should ' +
      'either skip explain-plan validation gracefully or refuse to run an ' +
      'unindexed-property report.',
  );

  it.todo(
    'AEMaaCS request timeout is ~60s for synchronous calls. The tool must ' +
      'force async dispatch on AEMaaCS at a much lower threshold than 500 ' +
      'pages when the property is unindexed (batched scan: 30 pages × ~200ms ' +
      'each = 6s for 900 pages, but jcr:content fetch latency dominates).',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Pre-execution explain-plan validation (DESIRED behaviour, not yet built)
// ───────────────────────────────────────────────────────────────────────────

describe('pre-execution explain-plan validation', () => {
  it.todo(
    'For unindexed properties, the tool should call queryBuilder.explainQuery() ' +
      'BEFORE running the actual scan. If the plan reports isTraversal=true, ' +
      'the tool must refuse to run and return a structured error with ' +
      '(a) the offending property, (b) the recommended index extension, ' +
      '(c) a suggested narrower rootPath.',
  );

  it.todo(
    'When the explain plan reports allRestrictionsHandledByIndex=false, the ' +
      'tool should still proceed but downgrade to async automatically and ' +
      'attach the explain result to the job so the caller can see why.',
  );

  it.todo(
    'When the explain servlet is unreachable (AEMaaCS publish, network error), ' +
      'the tool should fall back to the static index-coverage check and add ' +
      'a clear caveat in the response: "explain validation skipped".',
  );

  it.todo(
    'The tool must always find a better option: if a leading-wildcard or ' +
      'unindexed-property query is detected, it should suggest (1) a ' +
      'jcr:content/jcr:title fulltext alternative for jcr:title, (2) a ' +
      'narrower path constraint, or (3) async + checkpointed batched scan.',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Cancellation, checkpoint, and health-pause behaviour
// ───────────────────────────────────────────────────────────────────────────

describe('long-running execution safety', () => {
  it('passes a runner to jobManager.start that respects maxPages', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 10_000;
    });

    let capturedRunner:
      | ((ctx: unknown) => Promise<unknown>)
      | undefined;
    vi.mocked(jobManager.start).mockImplementation((_tool, _params, runner) => {
      capturedRunner = runner as typeof capturedRunner;
      return { jobId: 'job-x', message: 'queued', checkAfterMs: 1000 };
    });

    await pagePropertyReport({
      property: 'cq:template',
      rootPath: '/content/wknd',
      maxPages: 1_000, // > asyncThreshold so dispatch is async
    });

    expect(capturedRunner).toBeDefined();

    // Now invoke the runner with a fake context and verify queryAll is called
    // with maxPages=100, NOT the default 5000.
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({ hits: [], total: 0, more: false });
    const fakeCtx = {
      jobId: 'job-x',
      toolName: 'aem_page_property_report',
      getCheckpoint: () => undefined,
      saveCheckpoint: vi.fn(),
      setProgress: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue(undefined),
    };
    await capturedRunner!(fakeCtx);

    expect(queryBuilder.queryAll).toHaveBeenCalledWith(
      expect.any(Object),
      1_000,
    );
  });

  it('resumes batched scan from a saved checkpoint without re-processing', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 10_000;
    });

    let capturedRunner:
      | ((ctx: unknown) => Promise<unknown>)
      | undefined;
    vi.mocked(jobManager.start).mockImplementation((_tool, _params, runner) => {
      capturedRunner = runner as typeof capturedRunner;
      return { jobId: 'job-r', message: 'queued', checkAfterMs: 1000 };
    });

    await pagePropertyReport({
      property: 'myCustomProp',
      rootPath: '/content/wknd',
    });

    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: Array.from({ length: 90 }, (_, i) => ({
        'jcr:path': `/content/wknd/p${i}`,
      })),
      total: 90,
      more: false,
    });
    vi.mocked(aemClient.getNode).mockResolvedValue({ myCustomProp: 'val' });

    const previouslyProcessed = Array.from({ length: 60 }, (_, i) => ({
      pagePath: `/content/wknd/p${i}`,
      propertyValue: 'val',
      isMissing: false,
    }));

    const fakeCtx = {
      jobId: 'job-r',
      toolName: 'aem_page_property_report',
      getCheckpoint: () => ({
        pagePaths: Array.from({ length: 90 }, (_, i) => `/content/wknd/p${i}`),
        results: previouslyProcessed,
        nextBatchIndex: 2, // already processed batches 0 and 1 (60 pages)
      }),
      saveCheckpoint: vi.fn(),
      setProgress: vi.fn(),
      heartbeat: vi.fn().mockResolvedValue(undefined),
    };

    const result = (await capturedRunner!(fakeCtx)) as {
      pages: { pagePath: string }[];
    };

    // Should only fetch jcr:content for the remaining 30 pages.
    expect(aemClient.getNode).toHaveBeenCalledTimes(30);
    expect(result.pages.length).toBe(90);
  });

  it('heartbeats at least once per batch so the health guard can pause the job', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 10_000;
    });

    let capturedRunner:
      | ((ctx: unknown) => Promise<unknown>)
      | undefined;
    vi.mocked(jobManager.start).mockImplementation((_tool, _params, runner) => {
      capturedRunner = runner as typeof capturedRunner;
      return { jobId: 'job-h', message: 'queued', checkAfterMs: 1000 };
    });

    await pagePropertyReport({
      property: 'myCustomProp',
      rootPath: '/content/wknd',
    });

    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: Array.from({ length: 95 }, (_, i) => ({
        'jcr:path': `/content/wknd/p${i}`,
      })),
      total: 95,
      more: false,
    });
    vi.mocked(aemClient.getNode).mockResolvedValue({ myCustomProp: 'val' });

    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const fakeCtx = {
      jobId: 'job-h',
      toolName: 'aem_page_property_report',
      getCheckpoint: () => undefined,
      saveCheckpoint: vi.fn(),
      setProgress: vi.fn(),
      heartbeat,
    };

    await capturedRunner!(fakeCtx);

    // 95 pages / batchSize 30 → 4 batches → heartbeat called at least 4 times.
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it.todo(
    'When ctx.heartbeat() throws PauseJobError, the runner should propagate ' +
      'the pause (not swallow it) and leave a checkpoint that allows resume.',
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Input validation and adversarial edge cases
// ───────────────────────────────────────────────────────────────────────────

describe('input validation and edge cases', () => {
  it('treats an empty propertyValue as "no value filter"', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 1;
    });
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [{ 'jcr:path': '/content/wknd/en', 'jcr:content/cq:template': '/conf/x' }],
      total: 1,
      more: false,
    });

    await pagePropertyReport({
      property: 'cq:template',
      propertyValue: '',
      rootPath: '/content/wknd',
    });

    // Falsy propertyValue → tool currently maps to undefined via dispatch (in
    // index.ts) but at the function boundary it's '' and the indexed path
    // checks `propertyValue !== undefined`. Document the actual behaviour:
    const callArgs = vi.mocked(queryBuilder.queryAll).mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    // With current code, propertyValue='' DOES pass through and is treated as
    // an exact-match filter. That's likely a bug — the test pins the current
    // behaviour so a later fix is visible.
    expect(callArgs).toEqual(
      expect.objectContaining({ 'property.value': '' }),
    );
  });

  it('escapes special characters when matching propertyValue substring in batched scan', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 1;
    });
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [{ 'jcr:path': '/content/wknd/en' }],
      total: 1,
      more: false,
    });
    vi.mocked(aemClient.getNode).mockResolvedValue({
      myProp: 'value with [brackets] and (parens) and .dots',
    });

    const result = await pagePropertyReport({
      property: 'myProp',
      propertyValue: '[brackets]',
      rootPath: '/content/wknd',
    });

    expect('pages' in result && result.pages).toEqual([
      expect.objectContaining({ pagePath: '/content/wknd/en' }),
    ]);
  });

  it('handles array-valued properties when matching substring', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 1;
    });
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [{ 'jcr:path': '/content/wknd/en' }],
      total: 1,
      more: false,
    });
    vi.mocked(aemClient.getNode).mockResolvedValue({
      'cq:tags': ['wknd:activity/hiking', 'wknd:region/us'],
    });

    const result = await pagePropertyReport({
      property: 'cq:tags',
      propertyValue: 'hiking',
      rootPath: '/content/wknd',
    });

    expect('pages' in result && result.pages.length).toBe(1);
  });

  it('does not crash when jcr:content fetch fails for a page during batched scan', async () => {
    vi.mocked(queryBuilder.count).mockImplementation(async (params) => {
      if (params['type'] === 'cq:LiveSyncConfig') return 0;
      return 2;
    });
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/wknd/a' },
        { 'jcr:path': '/content/wknd/b' },
      ],
      total: 2,
      more: false,
    });
    vi.mocked(aemClient.getNode)
      .mockRejectedValueOnce(new Error('403 forbidden'))
      .mockResolvedValueOnce({ myProp: 'hit' });

    const result = await pagePropertyReport({
      property: 'myProp',
      propertyValue: 'hit',
      rootPath: '/content/wknd',
    });

    expect('pages' in result && result.pages).toEqual([
      expect.objectContaining({ pagePath: '/content/wknd/b' }),
    ]);
  });

  it.todo(
    'reportMissing=true should be mutually exclusive with propertyValue. ' +
      'Currently the tool silently ignores propertyValue when reportMissing ' +
      'is true; it should reject the call with a 400-style error.',
  );

  it.todo(
    'rootPath validation: paths outside /content, /conf, /apps, /var should ' +
      'be rejected. Currently any path is accepted as long as the underlying ' +
      'QueryBuilder safety check sees a "path" param.',
  );

  it.todo(
    'maxPages validation: must reject negative, zero, or NaN values, and cap ' +
      'at a hard ceiling (e.g. 50,000) regardless of caller request, so a ' +
      'rogue caller cannot ask for the entire repo.',
  );

  it.todo(
    'On AEM 6.5, the tool should accept maxPages up to a higher ceiling than ' +
      'AEMaaCS. The platform value from config must drive the ceiling.',
  );
});
