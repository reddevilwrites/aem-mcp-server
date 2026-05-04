import { aemClient, AemError } from '../aem-client.js';
import { queryBuilder } from '../query-builder.js';
import { logger } from '../utils/logger.js';

export interface PermissionAuditInput {
  /** JCR path to audit (e.g. /content/mysite/en) */
  path: string;
  /** Optional: filter to specific principal names (users or groups) */
  principals?: string[];
  /**
   * Depth to scan for ACE nodes (default: 1 = only the path itself).
   * Increase to find inherited or deep ACEs.
   */
  depth?: number;
}

export interface AceEntry {
  principal: string;
  type: 'allow' | 'deny';
  privileges: string[];
  path: string;
  isInherited: boolean;
  restrictions?: Record<string, string>;
}

export interface PermissionAuditResult {
  path: string;
  aceCount: number;
  entries: AceEntry[];
  principalSummary: Array<{
    principal: string;
    allowedPrivileges: string[];
    deniedPrivileges: string[];
  }>;
  recommendations: string[];
  note: string;
}

/**
 * Read ACL (Access Control Entries) for a given JCR path.
 *
 * Reads rep:policy nodes directly from the JCR — works in AEMaaCS (read-only)
 * and AEM 6.5/AMS. Requires the service user to have read access to rep:policy.
 *
 * Note: This reports the CONFIGURED ACEs, not effective (computed) permissions.
 * Effective permissions depend on group membership and parent path inheritance.
 */
export async function permissionAudit(
  input: PermissionAuditInput,
): Promise<PermissionAuditResult> {
  const { path, principals, depth = 1 } = input;

  const entries: AceEntry[] = [];

  // Read ACEs at the given path and optionally deeper
  await readAcesAtPath(path, false, entries);

  if (depth > 1) {
    // Scan child pages up to `depth` levels for their own rep:policy nodes
    try {
      const children = await queryBuilder.queryAll<{ 'jcr:path': string }>(
        {
          type: 'cq:Page',
          path,
          'p.hits': 'selective',
          'p.properties': 'jcr:path',
          'p.depth': String(depth),
        },
        500,
      );
      for (const child of children.hits) {
        const childPath = child['jcr:path'];
        if (childPath && childPath !== path) {
          await readAcesAtPath(childPath, true, entries);
        }
      }
    } catch (e) {
      logger.warn('Could not scan child paths for ACEs', e);
    }
  }

  // Filter by principal if requested
  const filtered = principals && principals.length > 0
    ? entries.filter(e => principals.includes(e.principal))
    : entries;

  // Build per-principal summary
  const principalMap = new Map<string, { allow: Set<string>; deny: Set<string> }>();
  for (const ace of filtered) {
    if (!principalMap.has(ace.principal)) {
      principalMap.set(ace.principal, { allow: new Set(), deny: new Set() });
    }
    const entry = principalMap.get(ace.principal)!;
    if (ace.type === 'allow') {
      ace.privileges.forEach(p => entry.allow.add(p));
    } else {
      ace.privileges.forEach(p => entry.deny.add(p));
    }
  }

  const principalSummary = Array.from(principalMap.entries()).map(([principal, privs]) => ({
    principal,
    allowedPrivileges: [...privs.allow],
    deniedPrivileges: [...privs.deny],
  }));

  // Recommendations
  const recommendations: string[] = [];

  const everyoneEntry = principalSummary.find(p => p.principal === 'everyone');
  if (everyoneEntry && everyoneEntry.allowedPrivileges.some(p => p.includes('write') || p.includes('modify'))) {
    recommendations.push(
      `SECURITY: "everyone" group has write/modify privileges on "${path}". ` +
      `This means any anonymous or authenticated user can modify this content.`,
    );
  }

  const adminEntries = principalSummary.filter(p =>
    /admin|administrators/i.test(p.principal) && p.allowedPrivileges.includes('jcr:all')
  );
  if (adminEntries.length === 0 && filtered.length > 0) {
    recommendations.push(
      `No admin/administrators ACE found directly on "${path}". ` +
      `Admin access may be inherited from a parent node — this is normal.`,
    );
  }

  if (filtered.length === 0) {
    recommendations.push(
      `No explicit ACEs found at "${path}". ` +
      `Access is controlled entirely by parent node inheritance.`,
    );
  }

  return {
    path,
    aceCount: filtered.length,
    entries: filtered,
    principalSummary,
    recommendations,
    note:
      'This reports explicit (configured) ACEs only. ' +
      'Effective permissions also depend on group membership and ACEs inherited from parent paths. ' +
      'In AEMaaCS production, CRXDE Lite access is restricted — results depend on service user permissions.',
  };
}

// ─── ACE reading helpers ───────────────────────────────────────────────────────

async function readAcesAtPath(
  path: string,
  isInherited: boolean,
  accumulator: AceEntry[],
): Promise<void> {
  try {
    // rep:policy is a special child node that holds ACEs
    const policy = await aemClient.getNode<Record<string, unknown>>(
      `${path}/rep:policy`,
      1,
    );

    for (const [key, value] of Object.entries(policy)) {
      if (typeof value !== 'object' || value === null) continue;
      const ace = value as Record<string, unknown>;

      const type = String(ace['jcr:primaryType'] ?? '');
      if (!type.includes('ACE') && !type.includes('ace')) continue;

      const principal = String(ace['rep:principalName'] ?? '');
      const privileges = normalisePrivileges(ace['rep:privileges']);
      const isAllow = type.includes('GrantACE') || type.includes('allow') || type.toLowerCase().includes('grant');

      const restrictions: Record<string, string> = {};
      for (const [rk, rv] of Object.entries(ace)) {
        if (rk.startsWith('rep:') && rk !== 'rep:principalName' && rk !== 'rep:privileges') {
          restrictions[rk] = String(rv);
        }
      }

      if (principal && privileges.length > 0) {
        accumulator.push({
          principal,
          type: isAllow ? 'allow' : 'deny',
          privileges,
          path,
          isInherited,
          restrictions: Object.keys(restrictions).length > 0 ? restrictions : undefined,
        });
      }
    }
  } catch (e) {
    if (e instanceof AemError && e.statusCode === 404) {
      // No rep:policy node — path has no explicit ACEs, which is normal
      return;
    }
    logger.warn(`Could not read ACEs at ${path}`, e);
  }
}

function normalisePrivileges(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map(s => s.trim());
  return [];
}
