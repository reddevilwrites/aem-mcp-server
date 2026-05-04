/**
 * Integration tests for the Streamable HTTP transport + bearer-token auth.
 *
 * These spin up a real http server bound to a random local port and exercise
 * the actual JSON-RPC + MCP framing — they're in tests/integration because
 * they touch the network stack, but they don't need an AEM instance.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assessLongRunningJobHealth: vi.fn(),
}));

vi.mock('../../src/tools/system-health.js', () => ({
  assessLongRunningJobHealth: mocks.assessLongRunningJobHealth,
}));

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHttpServer, HttpServerHandle } from '../../src/http-server.js';
import { jobManager } from '../../src/job-manager.js';
import { jobTelemetry } from '../../src/job-telemetry.js';

const AUTH_TOKEN = 'test-token-1234567890abcdef';

let baseUrl: string;
let handle: HttpServerHandle;

// Factory: produces a fresh test Server per session, mirroring how the real
// index.ts uses createMcpServer().
function createTestMcpServer(): Server {
  const server = new Server(
    { name: 'test-server', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ping',
        description: 'Test tool',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'test_async_job',
        description: 'Starts a test async job.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'test_async_pause_once',
        description: 'Starts a test async job that pauses once.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'aem_job_status',
        description: 'Test job status proxy.',
        inputSchema: { type: 'object', properties: { jobId: { type: 'string' } } },
      },
      {
        name: 'aem_job_observability',
        description: 'Test job observability proxy.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let result: unknown;

    if (name === 'test_async_job') {
      result = jobManager.start(
        'test_async_job',
        {},
        async (ctx) => {
          ctx.saveCheckpoint({ phase: 'scan', secret: 'hidden' });
          await ctx.heartbeat({
            checkpoint: { phase: 'complete', pagePaths: ['/content/private'] },
            progressPercent: 50,
            message: 'halfway',
            force: true,
          });
          return { ok: true };
        },
        5,
      );
    } else if (name === 'test_async_pause_once') {
      result = jobManager.start(
        'test_async_pause_once',
        {},
        async (ctx) => {
          const checkpoint = ctx.getCheckpoint<{ phase?: string }>();
          if (checkpoint?.phase === 'paused-once') {
            ctx.saveCheckpoint({ phase: 'resumed' });
            return { resumed: true };
          }
          await ctx.heartbeat({
            checkpoint: { phase: 'paused-once' },
            progressPercent: 10,
            message: 'before pause',
            force: true,
          });
          return { shouldNotReach: true };
        },
        5,
      );
    } else if (name === 'aem_job_status') {
      result = jobManager.getStatus(String((args as Record<string, unknown>)['jobId'] ?? ''));
    } else if (name === 'aem_job_observability') {
      const options = args as Record<string, unknown>;
      result = jobTelemetry.snapshot({
        jobId: options['jobId'] ? String(options['jobId']) : undefined,
        includeEvents: Boolean(options['includeEvents']),
        limit: options['limit'] ? Number(options['limit']) : undefined,
      });
    } else {
      result = { ok: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });
  return server;
}

mocks.assessLongRunningJobHealth.mockResolvedValue({
  action: 'continue',
  reason: 'ok',
  retryAfterMs: 1,
  snapshot: {},
});

beforeAll(async () => {
  // port: 0 → kernel picks a free port; the returned handle exposes the
  // actual port so we don't need a separate probe socket.
  handle = await startHttpServer(createTestMcpServer, {
    port: 0,
    authToken: AUTH_TOKEN,
    maxSessions: 3, // tight cap so the capacity test is fast
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
});

async function openSession(): Promise<string> {
  const initRes = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'observability-test', version: '0.0.1' },
      },
    }),
  });
  expect(initRes.status).toBe(200);
  await initRes.text();
  const sessionId = initRes.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function callTool<T>(
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const payload = parseSseJson(await res.text()) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(payload.result.content[0]!.text) as T;
}

async function closeSession(sessionId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'mcp-session-id': sessionId,
    },
  });
  expect([200, 202, 204]).toContain(res.status);
}

function parseSseJson(text: string): unknown {
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  expect(dataLine).toBeTruthy();
  return JSON.parse(dataLine!.slice('data: '.length));
}

async function pollJobStatus(sessionId: string, jobId: string, terminalStatus: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 1000;
  let last: Record<string, unknown> = {};

  while (Date.now() < deadline) {
    last = await callTool<Record<string, unknown>>(sessionId, 'aem_job_status', { jobId });
    if (last['status'] === terminalStatus) return last;
    await new Promise(r => setTimeout(r, 10));
  }

  throw new Error(`Timed out waiting for ${terminalStatus}; last=${JSON.stringify(last)}`);
}

describe('GET /healthz', () => {
  it('returns 200 without auth', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 200 even with a query string (regression: query string used to bypass route)', async () => {
    const res = await fetch(`${baseUrl}/healthz?probe=render`);
    expect(res.status).toBe(200);
  });
});

describe('CORS preflight', () => {
  it('returns 204 for OPTIONS with the requested headers allowed', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://claude.ai',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, mcp-session-id',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'mcp-session-id',
    );
  });
});

describe('bearer-token auth', () => {
  it('rejects requests with no Authorization header (401)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects requests with the wrong token (401)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token-here-1234567890',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed Authorization headers (401)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: AUTH_TOKEN, // missing "Bearer " prefix
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('path routing', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/something-else`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('session lifecycle', () => {
  it('rejects a non-initialize POST that has no session id (400)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('initialize → assigns session id, then tools/list works with that session', async () => {
    // 1. initialize
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.1' },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // 2. tools/list with the session id
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(listRes.status).toBe(200);

    // The SDK responds with SSE by default — parse the data line.
    const text = await listRes.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine!.slice('data: '.length)) as {
      result: { tools: { name: string }[] };
    };
    expect(payload.result.tools.map((t) => t.name)).toContain('ping');
  });

  it('rejects requests with an unknown session id (400)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'mcp-session-id': 'this-session-does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('body limits and validation', () => {
  it('returns 400 with a stable error message for invalid JSON (no parser internals echoed)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid JSON body.');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Capacity cap (regression: previously unbounded session map)
// ───────────────────────────────────────────────────────────────────────────

describe('async job observability over MCP', () => {
  it('shows start, heartbeat, checkpoint, and completion for an async job', async () => {
    jobTelemetry.clear();
    mocks.assessLongRunningJobHealth.mockResolvedValue({
      action: 'continue',
      reason: 'ok',
      retryAfterMs: 1,
      snapshot: {},
    });
    const sessionId = await openSession();

    try {
      const started = await callTool<{ jobId: string }>(sessionId, 'test_async_job');
      await pollJobStatus(sessionId, started.jobId, 'completed');

      const observed = await callTool<{
        jobs: Array<{
          heartbeatCount: number;
          checkpointSaveCount: number;
          hasCheckpoint: boolean;
          checkpointPhase?: string;
        }>;
        events: Array<{ type: string }>;
      }>(sessionId, 'aem_job_observability', {
        jobId: started.jobId,
        includeEvents: true,
      });

      expect(observed.jobs[0]).toEqual(expect.objectContaining({
        heartbeatCount: 1,
        checkpointSaveCount: 2,
        hasCheckpoint: true,
        checkpointPhase: 'complete',
      }));
      expect(observed.events.map(e => e.type)).toEqual([
        'job.started',
        'job.running',
        'job.checkpoint.saved',
        'job.checkpoint.saved',
        'job.heartbeat',
        'job.completed',
      ]);
      expect(JSON.stringify(observed)).not.toContain('hidden');
      expect(JSON.stringify(observed)).not.toContain('/content/private');
    } finally {
      await closeSession(sessionId);
    }
  });

  it('shows pause and resume telemetry when the health guard pauses once', async () => {
    jobTelemetry.clear();
    mocks.assessLongRunningJobHealth
      .mockResolvedValueOnce({
        action: 'pause',
        reason: 'health guard pause',
        retryAfterMs: 50,
        snapshot: {},
      })
      .mockResolvedValue({
        action: 'continue',
        reason: 'ok',
        retryAfterMs: 1,
        snapshot: {},
      });
    const sessionId = await openSession();

    try {
      const started = await callTool<{ jobId: string }>(sessionId, 'test_async_pause_once');
      await pollJobStatus(sessionId, started.jobId, 'paused');
      await pollJobStatus(sessionId, started.jobId, 'completed');

      const observed = await callTool<{
        jobs: Array<{
          pauseCount: number;
          resumeCount: number;
          checkpointSaveCount: number;
          hasCheckpoint: boolean;
          checkpointPhase?: string;
        }>;
        events: Array<{ type: string }>;
      }>(sessionId, 'aem_job_observability', {
        jobId: started.jobId,
        includeEvents: true,
      });

      expect(observed.jobs[0]).toEqual(expect.objectContaining({
        pauseCount: 1,
        resumeCount: 1,
        checkpointSaveCount: 2,
        hasCheckpoint: true,
        checkpointPhase: 'resumed',
      }));
      expect(observed.events.map(e => e.type)).toEqual([
        'job.started',
        'job.running',
        'job.checkpoint.saved',
        'job.heartbeat',
        'job.paused',
        'job.resumed',
        'job.running',
        'job.checkpoint.saved',
        'job.completed',
      ]);
    } finally {
      await closeSession(sessionId);
    }
  });
});

describe('session capacity cap', () => {
  it('rejects an invalid MCP_MAX_SESSIONS env value instead of disabling the cap', async () => {
    const previous = process.env['MCP_MAX_SESSIONS'];
    process.env['MCP_MAX_SESSIONS'] = 'not-a-number';

    try {
      await expect(
        startHttpServer(createTestMcpServer, {
          port: 0,
          authToken: AUTH_TOKEN,
        }),
      ).rejects.toThrow(/Invalid MCP_MAX_SESSIONS/);
    } finally {
      if (previous === undefined) {
        delete process.env['MCP_MAX_SESSIONS'];
      } else {
        process.env['MCP_MAX_SESSIONS'] = previous;
      }
    }
  });

  it('rejects new initialize requests once maxSessions is reached (503 + Retry-After)', async () => {
    // beforeAll already configured maxSessions=3. Open three sessions, then
    // a fourth initialize must be refused.
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'capacity-test', version: '0.0.1' },
      },
    });
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${AUTH_TOKEN}`,
    };

    const opened: string[] = [];
    while (handle.sessionCount() < 3) {
      const r = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: initBody });
      expect(r.status).toBe(200);
      const sid = r.headers.get('mcp-session-id');
      expect(sid).toBeTruthy();
      opened.push(sid!);
      // Drain the response body so the connection is released.
      await r.text();
    }

    const overflow = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: initBody,
    });
    expect(overflow.status).toBe(503);
    expect(overflow.headers.get('retry-after')).toBe('60');
    const errBody = (await overflow.json()) as { error: { message: string } };
    expect(errBody.error.message).toMatch(/at capacity/i);
  });
});
