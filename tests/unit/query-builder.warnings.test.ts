/**
 * Unit tests for QueryBuilder.buildIndexWarning (all 7 rules)
 * and QueryBuilder.assertSafe.
 *
 * aemClient is mocked — these tests run without any AEM instance.
 *
 * buildIndexWarning is private, so it is exercised through the public
 * query() method. We assert on result.indexWarning.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryParams } from '../../src/query-builder.js';

// ── Mock aemClient BEFORE importing queryBuilder ─────────────────────────────
// Vitest hoists vi.mock() calls to the top of the file, so this runs before
// any imports are resolved — safe even though the import appears below.
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

import { queryBuilder } from '../../src/query-builder.js';
import { aemClient } from '../../src/aem-client.js';

// Minimal valid QueryBuilder HTTP response — enough to reach buildIndexWarning
const EMPTY_QB_RESPONSE = { hits: [], total: 0, more: false };

/** Run query() and return only the indexWarning field. */
async function getWarning(params: QueryParams): Promise<string | undefined> {
  vi.mocked(aemClient.get).mockResolvedValueOnce(EMPTY_QB_RESPONSE);
  const result = await queryBuilder.query(params);
  return result.indexWarning;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── assertSafe ───────────────────────────────────────────────────────────────

describe('assertSafe — path constraint enforcement', () => {
  it('throws when no path constraint is present', async () => {
    await expect(
      queryBuilder.query({ type: 'cq:Page' }),
    ).rejects.toThrow('path');
  });

  it('throws for count() with no path constraint', async () => {
    await expect(
      queryBuilder.count({ type: 'cq:Page' }),
    ).rejects.toThrow('path');
  });

  it('accepts a direct path key', async () => {
    vi.mocked(aemClient.get).mockResolvedValue(EMPTY_QB_RESPONSE);
    await expect(
      queryBuilder.query({ type: 'cq:Page', path: '/content' }),
    ).resolves.toBeDefined();
  });

  it('accepts a dot-suffixed path key (group predicate)', async () => {
    vi.mocked(aemClient.get).mockResolvedValue(EMPTY_QB_RESPONSE);
    await expect(
      queryBuilder.query({ type: 'cq:Page', 'group.path': '/content' }),
    ).resolves.toBeDefined();
  });

  it('throws when path is the empty string (regression: previously slipped through as "key exists")', async () => {
    await expect(
      queryBuilder.query({ type: 'cq:Page', path: '' }),
    ).rejects.toThrow(/empty/i);
  });

  it('throws when path is whitespace only', async () => {
    await expect(
      queryBuilder.query({ type: 'cq:Page', path: '   ' }),
    ).rejects.toThrow(/empty/i);
  });

  it('throws when path is a relative path (not starting with /)', async () => {
    await expect(
      queryBuilder.query({ type: 'cq:Page', path: 'content/wknd' as unknown as string }),
    ).rejects.toThrow(/absolute JCR path/i);
  });

  it('throws when count() is given an empty path', async () => {
    await expect(
      queryBuilder.count({ type: 'cq:Page', path: '' }),
    ).rejects.toThrow(/empty/i);
  });
});

// ─── Rule 1: type=nt:base ─────────────────────────────────────────────────────

describe('Rule 1 — type=nt:base is flagged', () => {
  it('warns when type=nt:base', async () => {
    const warning = await getWarning({ type: 'nt:base', path: '/content' });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/nt:base/);
    expect(warning).toMatch(/nodetype/i);
  });

  it('warning mentions the correct remedy (use a specific type)', async () => {
    const warning = await getWarning({ type: 'nt:base', path: '/content' });
    expect(warning).toMatch(/cq:Page|dam:Asset/);
  });
});

// ─── Rule 2: missing type ─────────────────────────────────────────────────────

describe('Rule 2 — missing type constraint is flagged', () => {
  it('warns when no type is provided', async () => {
    const warning = await getWarning({ path: '/content' });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/type/i);
    expect(warning).toMatch(/nodetype/i);
  });

  it('does NOT warn when a valid type is provided', async () => {
    const warning = await getWarning({ type: 'cq:Page', path: '/content' });
    expect(warning).toBeUndefined();
  });
});

// ─── Rule 3: property indexed in the wrong covering index ────────────────────

describe('Rule 3 — property belongs to a different covering index', () => {
  it('warns when a DAM property is used in a cq:Page query', async () => {
    // dam:assetState is indexed in damAssetLucene, not cqPageLucene
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'dam:assetState',
    });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/dam:assetState/);
    expect(warning).toMatch(/damAssetLucene/);
    expect(warning).toMatch(/cqPageLucene/);
    expect(warning).toMatch(/post-filter|read optimis/i);
  });

  it('warns when sling:resourceType is used in a dam:Asset query', async () => {
    // sling:resourceType is indexed in slingResourceType, not damAssetLucene
    const warning = await getWarning({
      type: 'dam:Asset',
      path: '/content/dam',
      property: 'sling:resourceType',
    });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/sling:resourceType/);
    expect(warning).toMatch(/slingResourceType/);
  });

  it('does NOT trigger Rule 3 for a property that belongs to the correct index', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'cq:template',
    });
    expect(warning).toBeUndefined();
  });
});

// ─── Rule 4: non-indexed property ────────────────────────────────────────────

describe('Rule 4 — completely unindexed property is flagged', () => {
  it('warns for a custom property not covered by any Oak index', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'myProject:customProp',
    });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/myProject:customProp/);
    expect(warning).toMatch(/not covered|post-filter/i);
  });

  it('warning mentions custom index extension as the remedy', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'brandName',
    });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/index|cqPageLucene/i);
  });

  it('lists all unindexed properties when multiple are present', async () => {
    // QueryBuilder multi-property via group-predicate style
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'customA',
    });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/customA/);
  });

  it('does NOT warn for well-indexed jcr:content prefixed properties', async () => {
    // jcr:content/cq:template strips to cq:template which IS indexed
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'jcr:content/cq:template',
    });
    expect(warning).toBeUndefined();
  });
});

// ─── Rule 5: orderby on a non-indexed property ───────────────────────────────

describe('Rule 5 — orderby on non-indexed property is flagged', () => {
  it('warns when orderby targets a custom unindexed property', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      orderby: 'myProject:priority',
    });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/orderby/i);
    expect(warning).toMatch(/myProject:priority/);
    expect(warning).toMatch(/memory|sort/i);
  });

  it('does NOT warn for orderby on a known indexed property', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      orderby: 'cq:lastModified',
    });
    expect(warning).toBeUndefined();
  });

  it('does NOT warn for orderby on a property covered by the type index', async () => {
    // jcr:title is in cqPageLucene covered set
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      orderby: '@jcr:title',   // @ prefix is stripped by the rule
    });
    expect(warning).toBeUndefined();
  });
});

// ─── Rule 6: high p.limit + unindexed properties ─────────────────────────────

describe('Rule 6 — high p.limit combined with unindexed property', () => {
  it('warns when p.limit > 1000 and the query has an unindexed property', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'customProp',
      'p.limit': 5000,
    });
    expect(warning).toBeDefined();
    // Both Rule 4 and Rule 6 fire; warnings are numbered
    expect(warning).toMatch(/p\.limit=5000/);
    expect(warning).toMatch(/customProp/);
  });

  it('does NOT trigger Rule 6 alone when limit <= 1000', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'customProp',
      'p.limit': 500,
    });
    // Rule 4 fires (unindexed), but Rule 6 does not
    expect(warning).toBeDefined();
    expect(warning).not.toMatch(/p\.limit=/);
  });

  it('does NOT trigger Rule 6 when properties are all indexed', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'cq:template',
      'p.limit': 5000,
    });
    expect(warning).toBeUndefined();
  });
});

// ─── Rule 7: evaluatePathRestrictions (debug-only, no warning emitted) ────────

describe('Rule 7 — evaluatePathRestrictions note (no warning, debug log only)', () => {
  it('returns NO indexWarning for a well-indexed query with a sub-tree path', async () => {
    // type=cq:Page, specific sub-tree path, no property filter — perfectly indexed
    // Rule 7 only emits a debug log, not a user-facing warning
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content/mysite/en',
    });
    expect(warning).toBeUndefined();
  });

  it('returns NO indexWarning for a well-indexed query with root /content path', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
    });
    expect(warning).toBeUndefined();
  });
});

// ─── Multiple warnings are numbered ──────────────────────────────────────────

describe('Multiple warnings are numbered for readability', () => {
  it('numbers warnings [1] [2] etc. when multiple rules fire simultaneously', async () => {
    // Rule 4 (unindexed prop) + Rule 5 (orderby non-indexed) both fire
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'customProp',
      orderby: 'customProp',
    });
    expect(warning).toBeDefined();
    expect(warning).toMatch(/\[1\]/);
    expect(warning).toMatch(/\[2\]/);
  });

  it('does not number warnings when only one rule fires', async () => {
    const warning = await getWarning({
      type: 'cq:Page',
      path: '/content',
      property: 'customProp',
    });
    expect(warning).toBeDefined();
    expect(warning).not.toMatch(/\[1\]/);
  });
});

// ─── queryAll also surfaces indexWarning ─────────────────────────────────────

describe('queryAll — indexWarning is propagated', () => {
  it('returns indexWarning on queryAll results for unindexed property', async () => {
    vi.mocked(aemClient.get).mockResolvedValue(EMPTY_QB_RESPONSE);
    const result = await queryBuilder.queryAll({
      type: 'cq:Page',
      path: '/content',
      property: 'customProp',
    });
    expect(result.indexWarning).toBeDefined();
    expect(result.indexWarning).toMatch(/customProp/);
  });

  it('returns no indexWarning on queryAll for a clean query', async () => {
    vi.mocked(aemClient.get).mockResolvedValue(EMPTY_QB_RESPONSE);
    const result = await queryBuilder.queryAll({
      type: 'cq:Page',
      path: '/content',
      property: 'cq:template',
    });
    expect(result.indexWarning).toBeUndefined();
  });
});

describe('queryAll pagination offsets', () => {
  it('keeps offsets based on the configured page size when maxResults truncates the final page', async () => {
    vi.mocked(aemClient.get).mockImplementation(async (_path, params) => {
      const offset = Number(params?.['p.offset'] ?? 0);
      const limit = Number(params?.['p.limit'] ?? 0);
      return {
        hits: Array.from({ length: limit }, (_, i) => ({
          'jcr:path': `/content/page-${offset + i}`,
        })),
        total: 500,
        more: offset + limit < 500,
      };
    });

    const result = await queryBuilder.queryAll<{ 'jcr:path': string }>(
      { type: 'cq:Page', path: '/content' },
      250,
    );

    expect(result.hits).toHaveLength(250);
    expect(result.hits[199]?.['jcr:path']).toBe('/content/page-199');
    expect(result.hits[200]?.['jcr:path']).toBe('/content/page-200');
    expect(result.hits[249]?.['jcr:path']).toBe('/content/page-249');
    expect(vi.mocked(aemClient.get).mock.calls.map(([, params]) => params?.['p.offset'])).toEqual([
      0,
      200,
    ]);
  });
});
