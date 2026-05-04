import { aemClient, AemError } from '../aem-client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface ReplicationQueueInput {
  /** Which agents to check: 'author', 'preview', or 'all' (default: 'all') */
  agentType?: 'author' | 'preview' | 'all';
  /** Include items currently in queue (default: true) */
  includeQueueItems?: boolean;
}

export interface QueueItem {
  path: string;
  action: string;
  userId: string;
  time: string;
  priority?: string;
}

export interface AgentStatus {
  agentId: string;
  agentPath: string;
  transportUri: string;
  enabled: boolean;
  isBlocked: boolean;
  queueDepth: number;
  lastReplicationTime?: string;
  lastError?: string;
  queueItems: QueueItem[];
}

export interface ReplicationQueueResult {
  platform: string;
  totalAgents: number;
  blockedAgents: number;
  agents: AgentStatus[];
  recommendations: string[];
}

/**
 * ⚠️  AEM 6.5 / AMS ONLY — NOT available in AEM as a Cloud Service.
 *
 * In AEMaaCS, content replication is handled by Adobe's internal
 * Sling Content Distribution (SCD) pub-sub mechanism.
 * Custom replication agents and the /etc/replication endpoint do not exist.
 *
 * This tool reads replication agent status and queue depth via the
 * Replication REST API available in AEM 6.5 and AMS.
 */
export async function replicationQueueDiagnostics(
  input: ReplicationQueueInput = {},
): Promise<ReplicationQueueResult | { error: string; platform: string }> {
  const platform = config.aem.platform;

  if (platform === 'aemaacs') {
    return {
      error:
        'Replication Queue Diagnostics is NOT available in AEM as a Cloud Service. ' +
        'This feature is only supported on AEM 6.5 on-premise and AEM Managed Services (AMS). ' +
        'Re-run with AEM_PLATFORM=aem65 or AEM_PLATFORM=aem65lts pointed at a supported 6.5/AMS instance.',
      platform,
    };
  }

  const { agentType = 'all', includeQueueItems = true } = input;
  const recommendations: string[] = [];

  const agentRoots: string[] = [];
  if (agentType === 'all' || agentType === 'author') {
    agentRoots.push('/etc/replication/agents.author');
  }
  if (agentType === 'all' || agentType === 'preview') {
    agentRoots.push('/etc/replication/agents.preview');
  }

  const agents: AgentStatus[] = [];

  for (const root of agentRoots) {
    try {
      const agentList = await aemClient.getNode<Record<string, unknown>>(root, 1);
      for (const [agentId, agentNode] of Object.entries(agentList)) {
        if (
          typeof agentNode !== 'object' ||
          agentNode === null ||
          agentId.startsWith('jcr:')
        ) continue;

        const agentPath = `${root}/${agentId}`;
        const status = await fetchAgentStatus(agentPath, agentId, includeQueueItems);
        if (status) agents.push(status);
      }
    } catch (e) {
      if (e instanceof AemError && e.statusCode === 404) {
        logger.warn(`Replication agent root not found: ${root}`);
      } else {
        logger.error(`Error reading replication agents at ${root}`, e);
      }
    }
  }

  const blockedAgents = agents.filter(a => a.isBlocked || !a.enabled);

  // Recommendations
  if (agents.length === 0) {
    recommendations.push('No replication agents found. Check that this is an AEM Author instance.');
  }

  for (const agent of blockedAgents) {
    if (!agent.enabled) {
      recommendations.push(`Agent "${agent.agentId}" is DISABLED. Enable it if content publishing is expected.`);
    } else if (agent.isBlocked) {
      recommendations.push(
        `Agent "${agent.agentId}" is BLOCKED (queue depth: ${agent.queueDepth}). ` +
        `Error: ${agent.lastError ?? 'unknown'}. ` +
        `Resolve the transport error and then trigger a retry from /etc/replication.`,
      );
    }
  }

  const highQueueAgents = agents.filter(a => a.queueDepth > 100);
  for (const agent of highQueueAgents) {
    recommendations.push(
      `Agent "${agent.agentId}" has ${agent.queueDepth} items in queue. ` +
      `This may indicate a backlog or slow publisher.`,
    );
  }

  if (blockedAgents.length === 0 && agents.length > 0) {
    recommendations.push('All replication agents are active and unblocked.');
  }

  return {
    platform: 'aem65',
    totalAgents: agents.length,
    blockedAgents: blockedAgents.length,
    agents,
    recommendations,
  };
}

async function fetchAgentStatus(
  agentPath: string,
  agentId: string,
  includeQueueItems: boolean,
): Promise<AgentStatus | null> {
  try {
    const jcrContent = await aemClient.getNode<Record<string, unknown>>(
      `${agentPath}/jcr:content`,
      2,
    );

    const enabled = jcrContent['enabled'] !== false && jcrContent['enabled'] !== 'false';
    const transportUri = String(jcrContent['transportUri'] ?? '');
    const lastError = jcrContent['lastError']
      ? String(jcrContent['lastError'])
      : undefined;

    // Queue info is nested under jcr:content/queue
    const queueNode = (jcrContent['queue'] ?? {}) as Record<string, unknown>;
    const queueDepth = typeof queueNode['numEntries'] === 'number'
      ? queueNode['numEntries']
      : 0;
    const isBlocked = queueNode['blocked'] === true || queueNode['blocked'] === 'true';
    const lastReplicationTime = jcrContent['lastReplicationDate']
      ? new Date(Number(jcrContent['lastReplicationDate'])).toISOString()
      : undefined;

    let queueItems: QueueItem[] = [];
    if (includeQueueItems && queueDepth > 0) {
      queueItems = await fetchQueueItems(agentPath);
    }

    return {
      agentId,
      agentPath,
      transportUri,
      enabled,
      isBlocked,
      queueDepth,
      lastReplicationTime,
      lastError,
      queueItems,
    };
  } catch (e) {
    logger.warn(`Could not fetch agent status for ${agentPath}`, e);
    return null;
  }
}

async function fetchQueueItems(agentPath: string): Promise<QueueItem[]> {
  // AEM 6.5 Replication Queue REST endpoint
  try {
    interface QueueResponse {
      queue?: Array<Record<string, unknown>>;
    }
    const response = await aemClient.get<QueueResponse>(
      `${agentPath}.queue.json`,
    );
    return (response.queue ?? []).slice(0, 50).map((item: Record<string, unknown>) => ({
      path: String(item['path'] ?? ''),
      action: String(item['action'] ?? ''),
      userId: String(item['userId'] ?? ''),
      time: item['time']
        ? new Date(Number(item['time'])).toISOString()
        : String(item['time'] ?? ''),
      priority: item['priority'] ? String(item['priority']) : undefined,
    }));
    } catch {
    return [];
  }
}
