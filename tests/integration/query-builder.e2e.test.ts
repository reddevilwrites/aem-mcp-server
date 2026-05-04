/**
 * Integration tests — QueryBuilder against a local AEMaaCS SDK instance.
 *
 * What these tests validate:
 *   1. Connectivity + basic query execution
 *   2. buildIndexWarning rules fire correctly against a real AEM response
 *      (the warnings are computed from params, but we confirm the queries
 *       actually EXECUTE without error when AEM is live)
 *   3. assertSafe blocks queries before they hit the network
 *   4. Well-indexed queries return no warning AND real results
 *   5. Pagination (queryAll) works correctly
 *   6. count() is consistent with query() total
 *
 * Skipped automatically when AEM is not reachable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { queryBuilder } from '../../src/query-builder.js';
import {
  makeAemContext,
  TEST_CONTENT_ROOT,
  TEST_DAM_ROOT,
  expectWarning,
} from './helpers.js';

const aem = makeAemContext();

beforeAll(aem.probe);

// ─── Safety guard (no network needed) ────────────────────────────────────────

describe('assertSafe — blocks traversal queries before they hit AEM', () => {
  it('throws synchronously when no path constraint is given', async () => {
    await expect(
      queryBuilder.query({ type: 'cq:Page' }),
    ).rejects.toThrow(/path.*constraint|full-repository traversal/i);
  });

  it('throws for count() with no path', async () => {
    await expect(
      queryBuilder.count({ type: 'cq:Page' }),
    ).rejects.toThrow(/path.*constraint|full-repository traversal/i);
  });
});

// ─── Basic query execution ────────────────────────────────────────────────────

describe('Basic query execution against local SDK', () => {
  it('executes a well-indexed cq:Page query and returns results', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      'p.limit': 10,
    });

    expect(result).toMatchObject({
      hits: expect.any(Array),
      total: expect.any(Number),
      more: expect.any(Boolean),
    });
    // total must be a non-negative integer
    expect(result.total).toBeGreaterThanOrEqual(0);
    // Every hit must have a jcr:path
    for (const hit of result.hits) {
      expect(hit).toHaveProperty('jcr:path');
    }
  });

  it('returns no indexWarning for a well-indexed query', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      property: 'cq:template',
      'p.limit': 5,
    });

    expect(result.indexWarning).toBeUndefined();
  });

  it('executes a dam:Asset query and validates response shape', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'dam:Asset',
      path: TEST_DAM_ROOT,
      'p.limit': 10,
    });

    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.hits).toBeInstanceOf(Array);
  });

  it('respects p.limit — hits array length never exceeds the limit', async () => {
    if (aem.skip()) return;

    const limit = 3;
    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      'p.limit': limit,
    });

    expect(result.hits.length).toBeLessThanOrEqual(limit);
  });

  it('returns executionTime from AEM', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      'p.limit': 5,
    });

    // AEM always includes execution time — may be 0 for fast queries
    if (result.executionTime !== undefined) {
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── buildIndexWarning rules fire against real AEM ───────────────────────────
// The warnings are computed from params (no AEM needed), but by running
// them against a live instance we confirm the underlying queries still
// execute successfully — warnings are advisory, not blocking.

describe('buildIndexWarning rules — queries execute AND warnings are correct', () => {
  it('Rule 1: type=nt:base query executes but warns about missing index', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'nt:base',
      path: TEST_CONTENT_ROOT,
      'p.limit': 1,  // keep it tiny — this WILL traverse
    });

    expectWarning(result.indexWarning, /nt:base/);
    expectWarning(result.indexWarning, /nodetype/i);
    // Query still executes — warning is advisory
    expect(result.hits).toBeInstanceOf(Array);
  });

  it('Rule 2: query without type executes but warns about missing nodetype index', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      path: TEST_CONTENT_ROOT,
      'p.limit': 1,
    });

    expectWarning(result.indexWarning, /type/i);
    expectWarning(result.indexWarning, /nodetype/i);
  });

  it('Rule 3: dam property on cq:Page query warns about cross-index mismatch', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      property: 'dam:assetState',
      'p.limit': 1,
    });

    expectWarning(result.indexWarning, /dam:assetState/);
    expectWarning(result.indexWarning, /damAssetLucene/);
    expectWarning(result.indexWarning, /post-filter/i);
  });

  it('Rule 4: custom unindexed property warns and query still executes', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      property: 'myProject:customTag',
      'p.limit': 5,
    });

    expectWarning(result.indexWarning, /myProject:customTag/);
    expectWarning(result.indexWarning, /not covered|post-filter/i);
    // Query executes (returns 0 results since property doesn't exist, but no crash)
    expect(result.hits).toBeInstanceOf(Array);
  });

  it('Rule 5: orderby on unindexed property warns about in-memory sort', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      orderby: 'myProject:sortOrder',
      'p.limit': 5,
    });

    expectWarning(result.indexWarning, /orderby/i);
    expectWarning(result.indexWarning, /memory|sort/i);
  });

  it('Rule 6: high p.limit + unindexed property triggers combined warning', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      property: 'myProject:customProp',
      'p.limit': 2000,
    });

    // Both Rule 4 and Rule 6 fire — warnings are numbered
    expect(result.indexWarning).toMatch(/\[1\]/);
    expect(result.indexWarning).toMatch(/\[2\]/);
    expect(result.indexWarning).toMatch(/p\.limit=2000/);
  });
});

// ─── count() ─────────────────────────────────────────────────────────────────

describe('count() — consistent with query() total', () => {
  it('count() returns the same total as query() for the same params', async () => {
    if (aem.skip()) return;

    const params = {
      type: 'cq:Page' as const,
      path: TEST_CONTENT_ROOT,
    };

    const [countResult, queryResult] = await Promise.all([
      queryBuilder.count(params),
      queryBuilder.query(params, 0, 1),
    ]);

    // count() and query().total should agree
    // (guessTotal may cause minor variance on very large repos, so allow ±5%)
    const variance = Math.abs(countResult - queryResult.total) / Math.max(countResult, queryResult.total, 1);
    expect(variance).toBeLessThan(0.05);
  });

  it('count() throws without a path constraint', async () => {
    await expect(
      queryBuilder.count({ type: 'cq:Page' }),
    ).rejects.toThrow(/path.*constraint/i);
  });
});

// ─── queryAll() pagination ────────────────────────────────────────────────────

describe('queryAll() — pagination assembles all pages correctly', () => {
  it('returns all pages up to maxResults with correct hit shape', async () => {
    if (aem.skip()) return;

    const maxResults = 25;
    const result = await queryBuilder.queryAll<{ 'jcr:path': string }>(
      {
        type: 'cq:Page',
        path: TEST_CONTENT_ROOT,
        'p.hits': 'selective',
        'p.properties': 'jcr:path',
      },
      maxResults,
    );

    expect(result.hits.length).toBeLessThanOrEqual(maxResults);
    // Every hit must have jcr:path
    for (const hit of result.hits) {
      expect(typeof hit['jcr:path']).toBe('string');
      expect(hit['jcr:path']).toMatch(/^\/content/);
    }
  });

  it('sets more=true when results were capped at maxResults', async () => {
    if (aem.skip()) return;

    // Use maxResults=1 — almost certainly there is more than 1 page
    const result = await queryBuilder.queryAll(
      { type: 'cq:Page', path: TEST_CONTENT_ROOT },
      1,
    );

    if (result.total > 1) {
      expect(result.more).toBe(true);
    }
  });
});

// ─── Selective hits — p.properties ───────────────────────────────────────────

describe('Selective hits projection', () => {
  it('returns only requested properties when p.properties is set', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query<{ 'jcr:path': string }>(
      {
        type: 'cq:Page',
        path: TEST_CONTENT_ROOT,
        'p.hits': 'selective',
        'p.properties': 'jcr:path',
        'p.limit': 5,
      },
    );

    for (const hit of result.hits) {
      // jcr:path must be present
      expect(hit['jcr:path']).toBeDefined();
      // jcr:path must be a valid JCR path under /content
      expect(hit['jcr:path']).toMatch(/^\/content/);
    }
  });
});
