import { queryBuilder } from '../query-builder.js';
import { aemClient } from '../aem-client.js';
import { jobManager, JobStartResult } from '../job-manager.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface ClientlibAnalysisInput {
  /** Root to scan (default: /apps). Use /libs only if needed — large! */
  rootPath?: string;
  /** Filter by channel: 'publish', 'author', or undefined for all */
  channel?: string;
  async?: boolean;
}

export interface ClientlibEntry {
  path: string;
  categories: string[];
  dependencies: string[];
  embeds: string[];
  channels: string[];
  jsFiles: number;
  cssFiles: number;
  estimatedSizeKb?: number;
}

export interface CircularDependency {
  cycle: string[];
}

export interface ClientlibAnalysisResult {
  rootPath: string;
  totalClientlibs: number;
  clientlibs: ClientlibEntry[];
  circularDependencies: CircularDependency[];
  duplicateCategories: Array<{ category: string; definedIn: string[] }>;
  recommendations: string[];
  indexWarning?: string;
}

/**
 * Analyse AEM Client Libraries (cq:ClientLibraryFolder).
 *
 * Finds all clientlibs under rootPath, maps their dependencies and embeds,
 * detects circular dependencies and duplicate category names.
 *
 * Uses the nodetype Oak index (type=cq:ClientLibraryFolder) — index-safe.
 * Compatible with AEMaaCS and AEM 6.5/AMS.
 */
export async function clientlibAnalysis(
  input: ClientlibAnalysisInput = {},
): Promise<ClientlibAnalysisResult | JobStartResult> {
  const { rootPath = '/apps', channel } = input;

  const total = await queryBuilder.count({ type: 'cq:ClientLibraryFolder', path: rootPath });

  if (total > config.query.asyncThreshold || input.async) {
    return jobManager.start(
      'aem_clientlib_analysis',
      { rootPath, channel },
      () => runClientlibAnalysis(rootPath, channel),
      Math.max(15_000, total * 30),
    );
  }

  return runClientlibAnalysis(rootPath, channel);
}

async function runClientlibAnalysis(
  rootPath: string,
  channel: string | undefined,
): Promise<ClientlibAnalysisResult> {
  const result = await queryBuilder.queryAll<Record<string, unknown>>(
    {
      type: 'cq:ClientLibraryFolder',
      path: rootPath,
      'p.hits': 'selective',
      'p.properties': 'jcr:path categories dependencies embed channels',
    },
    5_000,
  );

  const allClientlibs: ClientlibEntry[] = [];

  for (const hit of result.hits) {
    const path = String(hit['jcr:path'] ?? '');
    if (!path) continue;

    const categories = normaliseArray(hit['categories']);
    const dependencies = normaliseArray(hit['dependencies']);
    const embeds = normaliseArray(hit['embed']);
    const channels = normaliseArray(hit['channels']);

    // Skip if channel filter set and doesn't match
    if (channel && channels.length > 0 && !channels.includes(channel)) continue;

    // Count JS/CSS files under this clientlib (best-effort)
    let jsFiles = 0;
    let cssFiles = 0;
    try {
      const node = await aemClient.getNode<Record<string, unknown>>(path, 1);
      for (const [key, val] of Object.entries(node)) {
        if (typeof val === 'object' && val !== null) {
          const child = val as Record<string, unknown>;
          const mime = String(child['jcr:mimeType'] ?? '');
          if (mime === 'application/javascript' || key.endsWith('.js')) jsFiles++;
          if (mime === 'text/css' || key.endsWith('.css')) cssFiles++;
        }
      }
    } catch { /* non-fatal */ }

    allClientlibs.push({ path, categories, dependencies, embeds, channels, jsFiles, cssFiles });
  }

  // ── Analysis ───────────────────────────────────────────────────────────────

  // Build category → paths map for duplicate detection
  const categoryMap = new Map<string, string[]>();
  for (const lib of allClientlibs) {
    for (const cat of lib.categories) {
      if (!categoryMap.has(cat)) categoryMap.set(cat, []);
      categoryMap.get(cat)!.push(lib.path);
    }
  }

  const duplicateCategories = [...categoryMap.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([category, definedIn]) => ({ category, definedIn }));

  // Circular dependency detection (DFS)
  const categoryToLibs = new Map<string, ClientlibEntry[]>();
  for (const lib of allClientlibs) {
    for (const cat of lib.categories) {
      if (!categoryToLibs.has(cat)) categoryToLibs.set(cat, []);
      categoryToLibs.get(cat)!.push(lib);
    }
  }

  const circularDependencies = detectCircularDeps(allClientlibs, categoryToLibs);

  // Recommendations
  const recommendations: string[] = [];

  if (duplicateCategories.length > 0) {
    recommendations.push(
      `${duplicateCategories.length} clientlib categor${duplicateCategories.length === 1 ? 'y' : 'ies'} defined in multiple locations. ` +
      `This can cause unpredictable CSS/JS loading order. Review: ${duplicateCategories.map(d => d.category).slice(0, 5).join(', ')}.`,
    );
  }

  if (circularDependencies.length > 0) {
    recommendations.push(
      `${circularDependencies.length} circular dependency chain(s) detected. ` +
      `These can cause build failures or incorrect JS/CSS loading. ` +
      `Cycles: ${circularDependencies.map(c => c.cycle.join(' → ')).slice(0, 3).join('; ')}.`,
    );
  }

  const deepEmbeds = allClientlibs.filter(l => l.embeds.length > 5);
  if (deepEmbeds.length > 0) {
    recommendations.push(
      `${deepEmbeds.length} clientlib(s) embed more than 5 other categories. ` +
      `Excessive embeds can significantly increase bundle size.`,
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('No clientlib issues detected.');
  }

  return {
    rootPath,
    totalClientlibs: allClientlibs.length,
    clientlibs: allClientlibs,
    circularDependencies,
    duplicateCategories,
    recommendations,
    indexWarning: result.indexWarning,
  };
}

// ─── Circular dependency detection (DFS) ──────────────────────────────────────

function detectCircularDeps(
  libs: ClientlibEntry[],
  categoryToLibs: Map<string, ClientlibEntry[]>,
): CircularDependency[] {
  const cycles: CircularDependency[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(category: string, stack: string[]): void {
    if (inStack.has(category)) {
      const cycleStart = stack.indexOf(category);
      cycles.push({ cycle: [...stack.slice(cycleStart), category] });
      return;
    }
    if (visited.has(category)) return;

    visited.add(category);
    inStack.add(category);
    stack.push(category);

    const libs = categoryToLibs.get(category) ?? [];
    for (const lib of libs) {
      for (const dep of lib.dependencies) {
        dfs(dep, stack);
      }
    }

    stack.pop();
    inStack.delete(category);
  }

  for (const lib of libs) {
    for (const cat of lib.categories) {
      if (!visited.has(cat)) {
        dfs(cat, []);
      }
    }
  }

  return cycles;
}

function normaliseArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}
