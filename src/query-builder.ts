import { aemClient } from './aem-client.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';

/**
 * Well-known indexed Oak properties and the primary index that backs them.
 * Used as fast-path lookup in static index analysis.
 *
 * Reference: AEM Oak indexes -- nodetype, slingResourceType, cqPageLucene,
 *            damAssetLucene, workflowDataLucene, authorizables, auditLogIndex
 */
export const INDEXED_PROPERTIES: Record<string, string> = {
  'jcr:primaryType':       'nodetype',
  'jcr:mixinTypes':        'nodetype',
  'sling:resourceType':    'slingResourceType',
  'cq:template':           'cqPageLucene',
  'jcr:title':             'cqPageLucene',
  'cq:lastModified':       'cqPageLucene',
  'cq:lastModifiedBy':     'cqPageLucene',
  'jcr:created':           'cqPageLucene',
  'jcr:createdBy':         'cqPageLucene',
  'sling:vanityPath':      'cqPageLucene',
  'hideInNav':             'cqPageLucene',
  'cq:tags':               'cqPageLucene',
  'onTime':                'cqPageLucene',
  'offTime':               'cqPageLucene',
  'cq:LiveRelationship':   'cqPageLucene',
  'dam:assetState':        'damAssetLucene',
  'dam:assetLastModified': 'damAssetLucene',
  'jcr:mimeType':          'damAssetLucene',
  'dam:sha1':              'damAssetLucene',
  'dc:title':              'damAssetLucene',
  'dc:description':        'damAssetLucene',
  'status':                'workflowDataLucene',
  'startTime':             'workflowDataLucene',
  'endTime':               'workflowDataLucene',
  'initiator':             'workflowDataLucene',
  'model':                 'workflowDataLucene',
  'currentAssignee':       'workflowDataLucene',
  'rep:principalName':     'authorizables',
  'rep:authorizableId':    'authorizables',
};

/**
 * Maps JCR node type to the covering Oak Lucene index for that type.
 *
 * Adobe best practice: every query should have a type constraint so AEM
 * can route it to the correct covering index and avoid cross-index traversal.
 */
const TYPE_INDEX_MAPPING: Record<string, string> = {
  'cq:Page':             'cqPageLucene',
  'cq:PageContent':      'cqPageLucene',
  'dam:Asset':           'damAssetLucene',
  'dam:AssetContent':    'damAssetLucene',
  'cq:WorkflowInstance': 'workflowDataLucene',
  'rep:User':            'authorizables',
  'rep:Group':           'authorizables',
  'rep:SystemUser':      'authorizables',
};

/**
 * Properties covered by each AEM covering Lucene index.
 *
 * A property used in a filter or orderby clause must appear in the index
 * definition for the query type; otherwise AEM post-filters the results
 * (reducing the read optimisation score) or falls back to traversal.
 *
 * Custom project-specific properties are NOT listed here -- those always
 * require explicit index extensions.
 */
const INDEX_COVERED_PROPERTIES: Record<string, Set<string>> = {
  cqPageLucene: new Set([
    'cq:template', 'jcr:title', 'cq:lastModified', 'cq:lastModifiedBy',
    'jcr:created', 'jcr:createdBy', 'sling:vanityPath', 'hideInNav',
    'cq:tags', 'onTime', 'offTime', 'cq:LiveRelationship',
  ]),
  damAssetLucene: new Set([
    'dam:assetState', 'dam:assetLastModified', 'jcr:mimeType',
    'dam:sha1', 'cq:tags', 'dc:title', 'dc:description', 'onTime', 'offTime',
  ]),
  workflowDataLucene: new Set([
    'status', 'startTime', 'endTime', 'initiator', 'model', 'currentAssignee',
  ]),
  authorizables: new Set([
    'rep:principalName', 'rep:authorizableId', 'profile/email',
  ]),
};

export type QueryParams = Record<string, string | number | boolean>;

export interface QueryBuilderResult<T = Record<string, unknown>> {
  hits: T[];
  total: number;
  more: boolean;
  /** Execution time reported by AEM (ms) */
  executionTime?: number;
  /** Warning if query may not be fully covered by an index */
  indexWarning?: string;
  /** Runtime explain result (populated only when explain:true is passed to query()) */
  explainResult?: ExplainQueryResult;
}

/**
 * Structured result from the AEM Explain Query servlet.
 *
 * The servlet endpoint is a real HTTP API available on both AEM 6.5/AMS and
 * AEMaaCS (author tier). It is NOT exposed via Cloud Manager API -- it is a
 * direct AEM instance endpoint:
 *   POST /libs/settings/granite/operations/diagnosis/granite_queryperformance.explain.json
 *
 * Cloud Manager "Query Performance" Developer Console UI reads from the same
 * backend but provides no programmable REST API of its own.
 */
export interface ExplainQueryResult {
  /** Raw Oak query plan string returned by the servlet */
  plan: string;
  /** Name of the Oak index that will be used, if determinable from the plan */
  indexUsed?: string;
  /**
   * True if Oak selected full traversal (plan contains "traverse" or "no-index").
   * Traversal is blocked at 100,000 nodes by Oak safety limit and is a hard
   * blocker in production.
   */
  isTraversal: boolean;
  /**
   * True when every filter and ordering restriction in the query is handled
   * inside the index (read optimisation score ~100%). False means some
   * restrictions are evaluated as post-filters -- the index returns a superset
   * and AEM discards non-matching rows after the fact.
   */
  allRestrictionsHandledByIndex: boolean;
  /** Human-readable recommendation derived from the plan */
  recommendation?: string;
}

interface RawQueryBuilderResponse {
  hits: Record<string, unknown>[];
  total: number;
  more: boolean;
  executionTime?: number;
}

interface ExplainServletResponse {
  plan?: string;
  statement?: string;
  executionTime?: number;
  explain?: {
    plan?: string;
    propertyIndexes?: string[];
    logs?: string[];
  };
}

/**
 * Safe QueryBuilder wrapper.
 *
 * Safety rules enforced at the framework level:
 *  1. Every query MUST include a path constraint -- prevents full-repo traversal.
 *  2. Every query SHOULD include a type constraint -- leverages the nodetype index.
 *  3. Property filters on non-indexed properties emit a warning.
 *  4. Results are always paginated (p.limit defaults to AEM_QUERY_PAGE_SIZE).
 *
 * Index analysis (static + optional runtime):
 *  Static:  validates type and property combinations against known Oak index
 *           coverage using rules from Adobe indexing best-practices docs.
 *  Runtime: optionally calls the AEM Explain Query servlet to obtain the actual
 *           Oak query plan at execution time. Pass explain:true to query() to
 *           enable. Falls back silently if the servlet is unavailable.
 */
export class QueryBuilder {
  /**
   * Execute a QueryBuilder query.
   *
   * @param params    Raw QueryBuilder key/value pairs
   * @param page      Zero-based page index
   * @param pageSize  Override page size (defaults to AEM_QUERY_PAGE_SIZE)
   * @param explain   When true, calls the Explain Query servlet for runtime index analysis
   */
  async query<T = Record<string, unknown>>(
    params: QueryParams,
    page = 0,
    pageSize?: number,
    explain = false,
  ): Promise<QueryBuilderResult<T>> {
    this.assertSafe(params);

    const effectivePageSize = this.resolvePageSize(params, pageSize);
    const offset = page * effectivePageSize;
    const finalParams: QueryParams = {
      ...params,
      'p.limit': effectivePageSize,
      'p.offset': offset,
    };

    logger.verboseDebug('QueryBuilder params', finalParams);

    const raw = await aemClient.get<RawQueryBuilderResponse>(
      '/bin/querybuilder.json',
      finalParams as Record<string, string | number | boolean>,
    );

    const indexWarning = this.buildIndexWarning(params);

    let explainResult: ExplainQueryResult | undefined;
    if (explain) {
      const sql2 = this.buildSql2(params);
      if (sql2) {
        explainResult = await this.explainQuery(sql2).catch(e => {
          logger.warn('Explain query failed (non-fatal), continuing without explain', e);
          return undefined;
        }) ?? undefined;
      } else {
        logger.debug('explainQuery skipped: params too complex to translate to SQL-2');
      }
    }

    const normalizedHits = (raw.hits ?? []).map(hit => this.normalizeHit(hit)) as T[];
    const total = raw.total ?? 0;
    const more = offset + normalizedHits.length < total || raw.more === true;

    return {
      hits: normalizedHits,
      total,
      more,
      executionTime: raw.executionTime,
      indexWarning,
      explainResult,
    };
  }

  /**
   * Fetch ALL results for a query, paginating automatically.
   * For large result sets use with caution -- prefer streaming or async jobs.
   *
   * @param maxResults Hard cap to prevent accidental full-repo scans (default: 5000)
   */
  async queryAll<T = Record<string, unknown>>(
    params: QueryParams,
    maxResults = 5000,
  ): Promise<QueryBuilderResult<T>> {
    const allHits: T[] = [];
    let page = 0;
    let moreAvailable = true;
    let total = 0;
    const configuredPageSize = this.resolvePageSize(params);

    while (moreAvailable && allHits.length < maxResults) {
      const remaining = maxResults - allHits.length;
      const result = await this.query<T>(params, page, configuredPageSize);
      total = result.total;
      allHits.push(...result.hits.slice(0, remaining));
      moreAvailable = result.more;
      page++;

      if (result.hits.length === 0) break;
    }

    return {
      hits: allHits,
      total,
      more: moreAvailable || allHits.length < total,
      indexWarning: this.buildIndexWarning(params),
    };
  }

  /**
   * Count results only (no hits returned). Efficient for existence checks
   * and async threshold decisions.
   */
  async count(params: QueryParams): Promise<number> {
    this.assertSafe(params);
    const result = await aemClient.get<RawQueryBuilderResponse>(
      '/bin/querybuilder.json',
      { ...params, 'p.limit': 0 } as Record<string, string | number | boolean>,
    );
    return result.total ?? 0;
  }

  /**
   * Call the AEM Explain Query servlet with a JCR-SQL2 query string.
   *
   * This is the same backend used by the Query Performance tool in AEM Developer
   * Console (accessible via Cloud Manager). The Developer Console UI has no
   * programmable REST API, but this servlet is directly callable at runtime.
   *
   * Plan string indicators:
   *   "lucene:cqPageLucene..."       -- Lucene index hit (good)
   *   "property:slingResourceType"   -- property index hit (good)
   *   "traverse..."                  -- full traversal (hard blocker in prod)
   *
   * Availability:
   *   AEM 6.5 / AMS:  yes (author instance, admin-level credentials)
   *   AEMaaCS:        yes (author tier, via service credentials)
   *   AEMaaCS publish: not accessible
   *
   * @param sql2  A JCR-SQL2 query string to explain
   */
  async explainQuery(sql2: string): Promise<ExplainQueryResult | null> {
    try {
      const response = await aemClient.post<ExplainServletResponse>(
        '/libs/settings/granite/operations/diagnosis/granite_queryperformance.explain.json',
        { statement: sql2, language: 'JCR-SQL2' },
      );

      const plan = response.explain?.plan ?? response.plan ?? '';
      if (!plan) {
        logger.debug('Explain servlet returned empty plan for query:', sql2);
        return null;
      }

      return this.parseExplainPlan(plan, response.statement ?? sql2);
    } catch (e) {
      logger.warn('explainQuery servlet call failed', e);
      return null;
    }
  }

  // Private helpers

  private assertSafe(params: QueryParams): void {
    const pathKeys = Object.keys(params).filter(k => k === 'path' || k.endsWith('.path'));
    if (pathKeys.length === 0) {
      throw new Error(
        'QueryBuilder safety violation: all queries must include a "path" constraint ' +
        'to prevent full-repository traversal. Add path=/content (or a more specific path).',
      );
    }
    // The presence of a path key isn't enough — empty / whitespace / non-string
    // values let the query degrade into a full-repo traversal. Validate every
    // path-bearing key.
    for (const key of pathKeys) {
      const value = params[key];
      if (typeof value !== 'string') {
        throw new Error(
          `QueryBuilder safety violation: "${key}" must be a string, got ${typeof value}.`,
        );
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        throw new Error(
          `QueryBuilder safety violation: "${key}" is empty. ` +
          'Provide a JCR path like "/content" or "/content/wknd".',
        );
      }
      if (!trimmed.startsWith('/')) {
        throw new Error(
          `QueryBuilder safety violation: "${key}"="${value}" must be an absolute JCR path ` +
          'starting with "/". Relative paths cause AEM to evaluate the query against the ' +
          'JCR root, which is full-repository traversal.',
        );
      }
    }
  }

  private resolvePageSize(params: QueryParams, pageSize?: number): number {
    const requested = pageSize ?? (
      params['p.limit'] !== undefined
        ? Number(params['p.limit'])
        : config.query.pageSize
    );

    if (!Number.isFinite(requested) || requested < 0) {
      return config.query.pageSize;
    }

    return Math.trunc(requested);
  }

  private normalizeHit(hit: Record<string, unknown>): Record<string, unknown> {
    if ('path' in hit && !('jcr:path' in hit)) {
      return { ...hit, 'jcr:path': hit['path'] };
    }
    return hit;
  }

  /**
   * Static analysis of QueryBuilder params to produce index coverage warnings.
   *
   * Rules applied (in priority order):
   *  1. type=nt:base -- no node-type restriction; cannot use nodetype index.
   *  2. Missing type -- nodetype index not leveraged; broader candidate set.
   *  3. Property against wrong type index -- property is indexed but in a
   *     different Lucene index from the one the query type selects; AEM
   *     post-filters, reducing the read optimisation score.
   *  4. Non-indexed property -- not in any known Oak index; AEM post-filters
   *     or traverses. Requires a custom index extension.
   *  5. orderby on non-indexed property -- in-memory sort after result fetch;
   *     slow on large result sets and worsens read optimisation score.
   *  6. High p.limit combined with non-indexed properties -- forces AEM to
   *     load a large number of nodes before filtering.
   *  7. evaluatePathRestrictions note -- logged at debug level when the query
   *     uses a Lucene-backed type with a sub-tree path, so developers building
   *     custom indexes know to set evaluatePathRestrictions=true.
   */
  private buildIndexWarning(params: QueryParams): string | undefined {
    const warnings: string[] = [];

    const typeValue = params['type'] !== undefined ? String(params['type']) : undefined;
    const limitValue = params['p.limit'] !== undefined ? Number(params['p.limit']) : undefined;
    const orderByParam = params['orderby'] !== undefined ? String(params['orderby']) : undefined;

    // Rule 1: nt:base is dangerous
    if (typeValue === 'nt:base') {
      warnings.push(
        'type=nt:base imposes no node-type restriction. AEM cannot use the nodetype ' +
        'index and will scan all nodes matching the path constraint. ' +
        'Replace with a specific type (e.g. cq:Page, dam:Asset) to anchor the query ' +
        'to the appropriate covering index.',
      );
    }

    // Rule 2: Missing type constraint
    if (typeValue === undefined) {
      warnings.push(
        'No "type" constraint found. Without a type constraint the nodetype index cannot ' +
        'be used, increasing the number of candidate nodes AEM must examine. ' +
        'Add type=cq:Page (or the appropriate node type) to anchor the query.',
      );
    }

    // Rules 3 & 4: Property index coverage
    const propertyConstraints = this.extractPropertyConstraints(params);
    const unindexed: string[] = [];
    const wrongIndex: Array<{ prop: string; inIndex: string; expectedIndex: string }> = [];

    const expectedIndex = typeValue ? TYPE_INDEX_MAPPING[typeValue] : undefined;
    const coveredProps = expectedIndex ? INDEX_COVERED_PROPERTIES[expectedIndex] : undefined;

    for (const prop of propertyConstraints) {
      const leafProp = prop.replace(/^jcr:content\//, '');
      const globalIndexForProp = INDEXED_PROPERTIES[leafProp] ?? INDEXED_PROPERTIES[prop];

      if (coveredProps) {
        if (!coveredProps.has(leafProp) && !coveredProps.has(prop)) {
          if (globalIndexForProp && expectedIndex && globalIndexForProp !== expectedIndex) {
            wrongIndex.push({ prop, inIndex: globalIndexForProp, expectedIndex });
          } else if (!globalIndexForProp) {
            unindexed.push(prop);
          }
        }
      } else {
        if (!globalIndexForProp) {
          unindexed.push(prop);
        }
      }
    }

    if (wrongIndex.length > 0) {
      const list = wrongIndex
        .map(({ prop, inIndex, expectedIndex: exp }) => `"${prop}" (indexed in ${inIndex}, not ${exp})`)
        .join(', ');
      warnings.push(
        `Properties ${list} are indexed but in a different Oak index than the one ` +
        `selected by this query's type. AEM will post-filter these constraints, ` +
        `reducing the read optimisation score below 100%. ` +
        `Extend the ${expectedIndex ?? 'target'} index definition to include these ` +
        `properties, or restructure the query to match the correct type.`,
      );
    }

    if (unindexed.length > 0) {
      warnings.push(
        `Properties [${unindexed.join(', ')}] are not covered by any known Oak index. ` +
        `AEM will evaluate these as post-filters after index traversal, which lowers the ` +
        `read optimisation score and increases query cost on large repositories. ` +
        `For production use, extend the covering index (e.g. cqPageLucene) with a ` +
        `custom propertyIndex entry, or create a dedicated Oak property index. ` +
        `Custom index extensions require a deployment on AEMaaCS.`,
      );
    }

    // Rule 5: orderby on non-indexed property
    if (orderByParam) {
      const orderProp = orderByParam.replace(/^@/, '').replace(/^jcr:content\//, '');
      const isIndexedGlobally = Boolean(INDEXED_PROPERTIES[orderProp]);
      const isCoveredByType = Boolean(coveredProps?.has(orderProp));

      if (!isIndexedGlobally && !isCoveredByType) {
        warnings.push(
          `orderby="${orderByParam}" targets a property that is not marked ordered=true ` +
          `in any known Oak index. AEM will sort results in memory after fetching them, ` +
          `which is slow on large result sets and worsens the read optimisation score. ` +
          `Either add ordered=true to the index property definition for "${orderProp}", ` +
          `or perform the sort client-side after receiving results.`,
        );
      }
    }

    // Rule 6: High limit + unindexed properties
    if (limitValue !== undefined && limitValue > 1000 && unindexed.length > 0) {
      warnings.push(
        `p.limit=${limitValue} combined with non-indexed properties [${unindexed.join(', ')}] ` +
        `forces AEM to read a large number of nodes before post-filtering. ` +
        `Consider reducing the limit, scoping the path constraint more tightly, ` +
        `or adding index coverage for these properties.`,
      );
    }

    // Rule 7: evaluatePathRestrictions note (debug-level only)
    if (expectedIndex && typeValue && typeValue !== 'nt:base') {
      const pathValue = String(params['path'] ?? '');
      if (pathValue.length > '/content'.length) {
        logger.debug(
          `[QueryBuilder] Query uses type=${typeValue} with path="${pathValue}". ` +
          `If using a custom index extension of ${expectedIndex}, ensure ` +
          `evaluatePathRestrictions=true is set so the path filter is applied ` +
          `inside the index and not as a post-filter.`,
        );
      }
    }

    if (warnings.length === 0) return undefined;
    if (warnings.length === 1) return warnings[0];
    return warnings.map((w, i) => `[${i + 1}] ${w}`).join('\n');
  }

  /**
   * Extract all property names from QueryBuilder params.
   *
   * Handles param naming patterns:
   *   property=jcr:title              (single predicate)
   *   property.value=foo              (single predicate with value)
   *   1_property=cq:template          (group predicate)
   *   group.property=sling:resourceType
   */
  private extractPropertyConstraints(params: QueryParams): string[] {
    const props: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (/(?:^|[._])property$/.test(key)) {
        const propName = String(value);
        if (propName) props.push(propName);
      }
    }
    return props;
  }

  /**
   * Translate QueryBuilder params to a JCR-SQL2 query string for use with
   * the Explain Query servlet.
   *
   * Handles common patterns:
   *   - type + path (ISDESCENDANTNODE)
   *   - single property=name + property.value=val  (equality filter)
   *   - single property=name without value          (existence check)
   *   - orderby + orderby.sort
   *
   * Returns null for params too complex to translate reliably
   * (multi-group predicates, fulltext, date ranges, etc.).
   */
  private buildSql2(params: QueryParams): string | null {
    const type = params['type'] !== undefined ? String(params['type']) : null;
    const path = params['path'] !== undefined ? String(params['path']) : null;

    if (!type || !path) return null;

    const complexKeys = Object.keys(params).filter(k =>
      /^[0-9]+_/.test(k) ||
      k.startsWith('group.') ||
      k === 'fulltext' ||
      k === 'daterange.lowerBound' ||
      k === 'daterange.upperBound' ||
      k === 'relativedaterange',
    );
    if (complexKeys.length > 0) return null;

    const escapedPath = path.replace(/'/g, "''");
    const conditions: string[] = [`ISDESCENDANTNODE(e, '${escapedPath}')`];

    const property = params['property'] !== undefined ? String(params['property']) : null;
    const propertyValue = params['property.value'] !== undefined
      ? String(params['property.value'])
      : null;

    if (property && propertyValue) {
      const escapedVal = propertyValue.replace(/'/g, "''");
      conditions.push(`e.[${property}] = '${escapedVal}'`);
    } else if (property) {
      conditions.push(`e.[${property}] IS NOT NULL`);
    }

    const orderByParam = params['orderby'] !== undefined ? String(params['orderby']) : null;
    let orderByClause = '';
    if (orderByParam) {
      const col = orderByParam.startsWith('@') ? orderByParam.slice(1) : orderByParam;
      const dir = params['orderby.sort'] === 'desc' ? 'DESC' : 'ASC';
      orderByClause = ` ORDER BY e.[${col}] ${dir}`;
    }

    return (
      `SELECT * FROM [${type}] AS e ` +
      `WHERE ${conditions.join(' AND ')}` +
      orderByClause
    );
  }

  /**
   * Parse an Oak query plan string from the Explain Query servlet.
   *
   * Common plan patterns:
   *   "lucene:cqPageLucene(/oak:index/cqPageLucene) path:/content/..."
   *   "property:slingResourceType(/oak:index/slingResourceType)"
   *   traverse "/content//*"
   *   no-index
   */
  private parseExplainPlan(plan: string, statement?: string): ExplainQueryResult {
    const lowerPlan = plan.toLowerCase();

    const isTraversal =
      lowerPlan.includes('traverse') ||
      lowerPlan.includes('no-index') ||
      lowerPlan.includes('no index');

    let indexUsed: string | undefined;
    const luceneMatch = plan.match(/lucene:([^\s(/,]+)/i);
    const propertyMatch = plan.match(/property:([^\s(/,]+)/i);

    if (luceneMatch?.[1]) {
      indexUsed = luceneMatch[1];
    } else if (propertyMatch?.[1]) {
      indexUsed = propertyMatch[1];
    }

    const hasPostFilter = /post[- ]?filter/i.test(plan) || /\bFilter\b/.test(plan);
    const queryProperties = statement ? this.extractSql2PropertyConstraints(statement) : [];
    const missingPropertyConditions = queryProperties.filter(prop => {
      const lowerProp = prop.toLowerCase();
      return !lowerPlan.includes(`[${lowerProp}]`) && !lowerPlan.includes(lowerProp);
    });
    const allRestrictionsHandledByIndex =
      !isTraversal &&
      !hasPostFilter &&
      missingPropertyConditions.length === 0;

    let recommendation: string | undefined;

    if (isTraversal) {
      recommendation =
        "FULL TRAVERSAL detected -- no Oak index was selected for this query. " +
        "This will be slow on large repositories and will hit Oak's 100,000-node " +
        "traversal safety limit. Ensure the query has both a type constraint and a " +
        "property filter covered by the appropriate index. For path-restricted queries, " +
        "verify the index has evaluatePathRestrictions=true.";
    } else if (!allRestrictionsHandledByIndex && indexUsed) {
      recommendation =
        `Index "${indexUsed}" was selected, but some restrictions are evaluated as ` +
        "post-filters (read optimisation score < 100%). " +
        "Extend the index definition to include the post-filtered properties with " +
        "propertyIndex=true and redeploy the index configuration.";
    } else if (indexUsed) {
      recommendation =
        `Index "${indexUsed}" selected -- all restrictions handled by the index ` +
        "(read optimisation score ~100%). Query is well-covered.";
    }

    return {
      plan,
      indexUsed,
      isTraversal,
      allRestrictionsHandledByIndex,
      recommendation,
    };
  }

  private extractSql2PropertyConstraints(sql2: string): string[] {
    const matches = sql2.matchAll(/\be\.\[([^\]]+)\]\s*(?:=|<>|<|>|<=|>=|like\b|is\s+not\s+null|is\s+null)/gi);
    const props: string[] = [];
    for (const match of matches) {
      const prop = match[1]?.trim();
      if (prop) props.push(prop);
    }
    return props;
  }
}

export const queryBuilder = new QueryBuilder();
