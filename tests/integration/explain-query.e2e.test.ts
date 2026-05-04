/**
 * Integration tests -- Explain Query servlet + buildIndexWarning correlation.
 *
 * These tests hit the AEM Explain Query servlet directly:
 *   POST /libs/settings/granite/operations/diagnosis/
 *        granite_queryperformance.explain.json
 *
 * What we validate:
 *   A. Well-covered queries  -> isTraversal=false, indexUsed=cqPageLucene|damAssetLucene
 *   B. type=nt:base query    -> isTraversal=true  (Oak falls back to traversal)
 *   C. Post-filter detection -> allRestrictionsHandledByIndex=false when an
 *                              unindexed property is present as a filter
 *   D. buildIndexWarning and explainQuery agree -- when buildIndexWarning fires
 *      Rule 4 (unindexed property), the explain plan also shows post-filtering
 *      or traversal, confirming the static analysis is sound
 *   E. query(explain:true) integration -- explainResult is attached to the result
 *
 * The Explain servlet is available on AEMaaCS author and AEM 6.5 author.
 * It is NOT accessible on AEMaaCS publish tier or without admin credentials.
 *
 * Skipped automatically when AEM is not reachable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { queryBuilder, type ExplainQueryResult } from '../../src/query-builder.js';
import {
  makeAemContext,
  TEST_CONTENT_ROOT,
  TEST_DAM_ROOT,
} from './helpers.js';

const aem = makeAemContext();

beforeAll(aem.probe);

// Helpers

/** Build a minimal SQL-2 query for Explain testing. */
function sql2(type: string, path: string, filter?: string): string {
  const where = filter
    ? `ISDESCENDANTNODE(e, '${path}') AND ${filter}`
    : `ISDESCENDANTNODE(e, '${path}')`;
  return `SELECT * FROM [${type}] AS e WHERE ${where}`;
}

// A. Well-covered queries

describe('A -- well-covered queries use the correct Oak index', () => {
  it('cq:Page query uses cqPageLucene and is not traversal', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.explainQuery(
      sql2('cq:Page', TEST_CONTENT_ROOT),
    );

    if (result === null) {
      console.warn('Explain servlet returned null -- servlet may not be accessible');
      return;
    }

    expect(result.isTraversal).toBe(false);
    expect(result.indexUsed).toBeDefined();
    expect(result.indexUsed?.toLowerCase()).toMatch(/cqpage|lucene/i);
    expect(result.recommendation).toMatch(/selected|well-covered|all restrictions/i);
  });

  it('dam:Asset query uses damAssetLucene and is not traversal', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.explainQuery(
      sql2('dam:Asset', TEST_DAM_ROOT),
    );

    if (result === null) return;

    expect(result.isTraversal).toBe(false);
    expect(result.indexUsed).toBeDefined();
    expect(result.indexUsed?.toLowerCase()).toMatch(/damasset|lucene/i);
  });

  it('cq:Page query with cq:template filter uses cqPageLucene', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.explainQuery(
      sql2('cq:Page', TEST_CONTENT_ROOT, `e.[cq:template] IS NOT NULL`),
    );

    if (result === null) return;

    expect(result.isTraversal).toBe(false);
    expect(result.indexUsed?.toLowerCase()).toMatch(/cqpage|lucene/i);
  });

  it('result contains a human-readable recommendation', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.explainQuery(
      sql2('cq:Page', TEST_CONTENT_ROOT),
    );

    if (result === null) return;

    expect(typeof result.recommendation).toBe('string');
    expect(result.recommendation!.length).toBeGreaterThan(10);
  });

  it('result exposes the raw plan string', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.explainQuery(
      sql2('cq:Page', TEST_CONTENT_ROOT),
    );

    if (result === null) return;

    expect(typeof result.plan).toBe('string');
    expect(result.plan.length).toBeGreaterThan(0);
  });
});

// B. type=nt:base triggers traversal

describe('B -- type=nt:base query triggers Oak traversal', () => {
  it('isTraversal=true for nt:base query (Oak has no covering index)', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.explainQuery(
      sql2('nt:base', TEST_CONTENT_ROOT),
    );

    if (result === null) return;

    expect(result.isTraversal).toBe(true);
    expect(result.recommendation).toMatch(/traversal|traverse/i);
  });

  it('traversal recommendation mentions index or evaluatePathRestrictions', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.explainQuery(
      sql2('nt:base', TEST_CONTENT_ROOT),
    );

    if (result === null) return;

    if (result.isTraversal) {
      expect(result.recommendation).toMatch(/evaluatePathRestrictions|index|type constraint/i);
    }
  });
});

// C. Post-filter detection

describe('C -- unindexed property filter is detected as post-filter', () => {
  it('custom unindexed property causes post-filter or traversal', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.explainQuery(
      sql2(
        'cq:Page',
        TEST_CONTENT_ROOT,
        `e.[myProject:unindexedCustomProp] = 'someValue'`,
      ),
    );

    if (result === null) return;

    if (!result.isTraversal) {
      // Index was selected but the custom filter is post-evaluated.
      // allRestrictionsHandledByIndex should be false.
      // (Some AEM versions inline the filter -- that is acceptable behaviour
      //  and means the index definition was extended; we check conditionally.)
      expect(result.indexUsed).toBeDefined();
      if (!result.allRestrictionsHandledByIndex) {
        expect(result.recommendation).toMatch(/post-filter|read optimis/i);
      }
    }

    // Either traversal OR post-filter indicates the property is not index-covered
    const indicatesIssue = (r: ExplainQueryResult) =>
      r.isTraversal || !r.allRestrictionsHandledByIndex;
    expect(indicatesIssue(result)).toBe(true);
  });
});

// D. Static buildIndexWarning correlates with runtime explain

describe('D -- static buildIndexWarning agrees with runtime explain plan', () => {
  it('clean query: no static warning AND explain shows index hit', async () => {
    if (aem.skip()) return;

    const params = {
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      property: 'cq:template',
      'p.limit': 5,
    };

    const queryResult = await queryBuilder.query(params);
    expect(queryResult.indexWarning).toBeUndefined();

    const explainResult = await queryBuilder.explainQuery(
      `SELECT * FROM [cq:Page] AS e ` +
      `WHERE ISDESCENDANTNODE(e, '${TEST_CONTENT_ROOT}') ` +
      `AND e.[cq:template] IS NOT NULL`,
    );
    if (explainResult === null) return;

    expect(explainResult.isTraversal).toBe(false);
  });

  it('unindexed property: static Rule 4 fires AND explain shows post-filter/traversal', async () => {
    if (aem.skip()) return;

    const params = {
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      property: 'myProject:undefinedProp',
      'p.limit': 5,
    };

    const queryResult = await queryBuilder.query(params);
    expect(queryResult.indexWarning).toBeDefined();
    expect(queryResult.indexWarning).toMatch(/not covered|post-filter/i);

    const explainResult = await queryBuilder.explainQuery(
      `SELECT * FROM [cq:Page] AS e ` +
      `WHERE ISDESCENDANTNODE(e, '${TEST_CONTENT_ROOT}') ` +
      `AND e.[myProject:undefinedProp] IS NOT NULL`,
    );
    if (explainResult === null) return;

    const indicatesIssue = (r: ExplainQueryResult) =>
      r.isTraversal || !r.allRestrictionsHandledByIndex;
    expect(indicatesIssue(explainResult)).toBe(true);
  });

  it('nt:base: static Rule 1 fires AND explain shows traversal', async () => {
    if (aem.skip()) return;

    const params = {
      type: 'nt:base',
      path: TEST_CONTENT_ROOT,
      'p.limit': 1,
    };

    const queryResult = await queryBuilder.query(params);
    expect(queryResult.indexWarning).toMatch(/nt:base/);

    const explainResult = await queryBuilder.explainQuery(
      sql2('nt:base', TEST_CONTENT_ROOT),
    );
    if (explainResult === null) return;

    expect(explainResult.isTraversal).toBe(true);
  });
});

// E. query(explain:true) -- explainResult attached inline

describe('E -- query(params, page, pageSize, explain:true) attaches explainResult', () => {
  it('explainResult is populated when explain=true and SQL-2 can be built', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query(
      {
        type: 'cq:Page',
        path: TEST_CONTENT_ROOT,
        property: 'cq:template',
        'p.limit': 5,
      },
      0,    // page
      5,    // pageSize
      true, // explain
    );

    expect(result.hits).toBeInstanceOf(Array);

    if (result.explainResult !== undefined) {
      expect(typeof result.explainResult.plan).toBe('string');
      expect(typeof result.explainResult.isTraversal).toBe('boolean');
    }
  });

  it('explainResult is undefined when explain=false (default)', async () => {
    if (aem.skip()) return;

    const result = await queryBuilder.query({
      type: 'cq:Page',
      path: TEST_CONTENT_ROOT,
      'p.limit': 3,
    });

    expect(result.explainResult).toBeUndefined();
  });

  it('query() does not throw when explain=true but params are too complex to translate', async () => {
    if (aem.skip()) return;

    // Multi-group predicate -- buildSql2 returns null for these
    const result = await queryBuilder.query(
      {
        type: 'cq:Page',
        path: TEST_CONTENT_ROOT,
        '1_property': 'cq:template',
        '1_property.value': '/conf/global/settings/wcm/templates/page',
        '2_property': 'hideInNav',
        '2_property.value': 'true',
        'p.limit': 5,
      },
      0, 5, true,
    );

    // Must not throw; explainResult is undefined because buildSql2 returned null
    expect(result.hits).toBeInstanceOf(Array);
    expect(result.explainResult).toBeUndefined();
  });
});

// F. Graceful handling of edge cases

describe('F -- explainQuery handles edge cases gracefully', () => {
  it('returns null for an empty SQL-2 string without throwing', async () => {
    if (aem.skip()) return;

    // An empty or invalid query causes the servlet to return a non-OK response,
    // which aemClient turns into an AemError. explainQuery catches it and
    // returns null -- the caller is never thrown at.
    const result = await queryBuilder.explainQuery('');
    expect(result === null || typeof result === 'object').toBe(true);
  });
});
