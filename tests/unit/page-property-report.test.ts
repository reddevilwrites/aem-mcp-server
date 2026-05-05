import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { aemClient } from '../../src/aem-client.js';
import { queryBuilder } from '../../src/query-builder.js';
import { pagePropertyReport, trimToMasterRoot } from '../../src/tools/page-property-report.js';

describe('pagePropertyReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryBuilder.count).mockResolvedValue(1);
    vi.mocked(queryBuilder.query).mockResolvedValue({ hits: [], total: 0, more: false });
  });

  it('uses a scoped fulltext filter for jcr:title searches', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        {
          'jcr:path': '/content/wknd/us/en/adventures',
          'jcr:content/jcr:title': 'WKND Adventure',
        },
      ],
      total: 1,
      more: false,
    });

    const result = await pagePropertyReport({
      property: 'jcr:title',
      propertyValue: 'WKND',
      rootPath: '/content/wknd',
    });

    expect(queryBuilder.queryAll).toHaveBeenCalledWith(
      expect.objectContaining({
        fulltext: 'WKND',
        'fulltext.relPath': 'jcr:content/jcr:title',
      }),
      5000,
    );
    expect('pages' in result && result.pages).toEqual([
      {
        pagePath: '/content/wknd/us/en/adventures',
        propertyValue: 'WKND Adventure',
        isMissing: false,
      },
    ]);
  });

  it('keeps exact property matching for non-text indexed filters', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [],
      total: 0,
      more: false,
    });

    await pagePropertyReport({
      property: 'cq:template',
      propertyValue: '/conf/wknd/settings/wcm/templates/adventure-page',
      rootPath: '/content/wknd',
    });

    expect(queryBuilder.queryAll).toHaveBeenCalledWith(
      expect.objectContaining({
        property: 'jcr:content/cq:template',
        'property.value': '/conf/wknd/settings/wcm/templates/adventure-page',
      }),
      5000,
    );
    expect(queryBuilder.queryAll).not.toHaveBeenCalledWith(
      expect.objectContaining({
        fulltext: expect.anything(),
      }),
      5000,
    );
  });

  it('uses an existence predicate and fallback jcr:content reads for indexed property reports without a value filter', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/wknd/language-masters/en' },
        {
          'jcr:path': '/content/wknd/language-masters/en/adventures',
          'jcr:content/cq:template': '/conf/wknd/settings/wcm/templates/adventure-page',
        },
      ],
      total: 2,
      more: false,
    });
    vi.mocked(aemClient.getNode).mockResolvedValue({
      'cq:template': '/conf/wknd/settings/wcm/templates/page-content',
    });

    const result = await pagePropertyReport({
      property: 'cq:template',
      rootPath: '/content/wknd/language-masters/en',
      maxPages: 200,
    });

    expect(queryBuilder.queryAll).toHaveBeenCalledWith(
      expect.objectContaining({
        property: 'jcr:content/cq:template',
        'p.properties': 'jcr:path jcr:content/cq:template',
      }),
      200,
    );
    expect(aemClient.getNode).toHaveBeenCalledWith(
      '/content/wknd/language-masters/en/jcr:content',
    );
    expect('pages' in result && result.pages).toEqual([
      {
        pagePath: '/content/wknd/language-masters/en',
        propertyValue: '/conf/wknd/settings/wcm/templates/page-content',
        isMissing: false,
      },
      {
        pagePath: '/content/wknd/language-masters/en/adventures',
        propertyValue: '/conf/wknd/settings/wcm/templates/adventure-page',
        isMissing: false,
      },
    ]);
    expect('telemetry' in result && result.telemetry).toMatchObject({
      strategy: 'fast-indexed-query',
      candidatePageCount: 2,
      queryHitValueCount: 1,
      fallbackReadCount: 1,
      fallbackValueCount: 1,
      missingValueCount: 0,
    });
  });

  it('matches substring values during batched scans for unindexed properties', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/wknd/us/en/adventures' },
        { 'jcr:path': '/content/wknd/us/en/contact' },
      ],
      total: 2,
      more: false,
    });

    vi.mocked(aemClient.getNode)
      .mockResolvedValueOnce({ 'my:title': 'WKND Adventure' })
      .mockResolvedValueOnce({ 'my:title': 'Contact Us' });

    const result = await pagePropertyReport({
      property: 'my:title',
      propertyValue: 'WKND',
      rootPath: '/content/wknd',
    });

    expect('pages' in result && result.pages).toEqual([
      {
        pagePath: '/content/wknd/us/en/adventures',
        propertyValue: 'WKND Adventure',
        isMissing: false,
      },
    ]);
  });

  it('counts missing-property report entries as matches', async () => {
    vi.mocked(queryBuilder.queryAll).mockResolvedValue({
      hits: [
        { 'jcr:path': '/content/wknd/us/en/adventures' },
        { 'jcr:path': '/content/wknd/us/en/contact' },
      ],
      total: 2,
      more: false,
    });

    vi.mocked(aemClient.getNode)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'my:title': 'Contact Us' });

    const result = await pagePropertyReport({
      property: 'my:title',
      reportMissing: true,
      rootPath: '/content/wknd',
    });

    expect('matchingPageCount' in result && result.matchingPageCount).toBe(1);
    expect('pages' in result && result.pages).toEqual([
      {
        pagePath: '/content/wknd/us/en/adventures',
        propertyValue: null,
        isMissing: true,
      },
    ]);
  });
});

describe('trimToMasterRoot — MSM master-root detection', () => {
  it('trims a deep master path to the language-master root (language-masters layout)', () => {
    expect(
      trimToMasterRoot('/content/wknd/language-masters/en/articles/foo'),
    ).toBe('/content/wknd/language-masters/en');
  });

  it('trims a deep livecopy path to the country/lang root (countryCode layout)', () => {
    expect(
      trimToMasterRoot('/content/wknd/us/en/articles/foo'),
    ).toBe('/content/wknd/us/en');
  });

  it('returns the same path when it is already at the master root', () => {
    expect(trimToMasterRoot('/content/wknd/language-masters/en')).toBe(
      '/content/wknd/language-masters/en',
    );
  });

  it('handles locale-suffixed language codes (en_US, en-GB)', () => {
    expect(trimToMasterRoot('/content/wknd/us/en_US/foo')).toBe(
      '/content/wknd/us/en_US',
    );
    expect(trimToMasterRoot('/content/wknd/uk/en-GB/foo')).toBe(
      '/content/wknd/uk/en-GB',
    );
  });

  it('returns undefined for paths that do not match the standard MSM layout', () => {
    // Extra segment (e.g. /content/sites/wknd/...) — not the standard layout.
    expect(trimToMasterRoot('/content/sites/wknd/lang-masters/en/foo')).toBeUndefined();
    // Missing language code segment.
    expect(trimToMasterRoot('/content/wknd/language-masters')).toBeUndefined();
    // Not under /content.
    expect(trimToMasterRoot('/etc/wknd/language-masters/en')).toBeUndefined();
    // Three-letter "country" — not ISO 3166-1 alpha-2.
    expect(trimToMasterRoot('/content/wknd/usa/en/foo')).toBeUndefined();
  });

  it('does not over-match — adjacent path segments after the master root are NOT included', () => {
    // Regression for the original bug: split('/').slice(0, 5) dropped the
    // language code when the path had an extra leading segment. The fix
    // matches structurally so the trimmed result always includes the
    // language code and stops there.
    const result = trimToMasterRoot('/content/wknd/language-masters/en/articles/2026/foo');
    expect(result).toBe('/content/wknd/language-masters/en');
  });
});
