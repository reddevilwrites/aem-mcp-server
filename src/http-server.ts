/**
 * Streamable HTTP transport for the AEM MCP server.
 *
 * Wraps Node's built-in http server with:
 *   - bearer-token auth (single shared secret via MCP_AUTH_TOKEN)
 *   - per-session StreamableHTTPServerTransport instances (stateful mode)
 *   - permissive CORS so claude.ai / Claude Desktop / Cursor can call /mcp
 *   - GET /healthz for PaaS liveness probes
 *
 * Demo-grade auth only. Production should swap the bearer-token check for
 * OAuth 2.1 + PKCE per the MCP spec — the transport layer below is unchanged.
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from './utils/logger.js';

const SESSION_HEADER = 'mcp-session-id';

/**
 * Soft cap on the number of concurrent MCP sessions. New `initialize` calls
 * over this limit are rejected with HTTP 503 until existing sessions close.
 * Override via MCP_MAX_SESSIONS env var.
 *
 * Why a hard reject (not LRU eviction): on a public demo URL, eviction lets a
 * holder of the bearer token displace legitimate sessions by spamming
 * `initialize`. Rejection preserves the in-flight users' work.
 */
const DEFAULT_MAX_SESSIONS = 100;

export interface HttpServerOptions {
  port: number;
  authToken: string;
  /** Override the default session cap (env: MCP_MAX_SESSIONS). */
  maxSessions?: number;
}

export interface HttpServerHandle {
  /** The actual port bound (useful when port=0 was passed for tests). */
  port: number;
  /** Number of currently-active sessions. */
  sessionCount(): number;
  /** Stop accepting new connections, close active sessions, await full shutdown. */
  close(): Promise<void>;
}

/**
 * A factory that produces a fresh MCP Server instance per call.
 *
 * Required because the MCP SDK's `Server.connect()` can only attach to one
 * transport per Server instance. Each new HTTP session creates a new
 * transport, so it needs a fresh Server with the same handler registration.
 */
export type McpServerFactory = () => Server;

/**
 * Start the HTTP server. The returned handle exposes a `close()` method —
 * callers (index.ts, tests) are responsible for calling it. This function
 * deliberately does NOT register process signal handlers; that is the
 * responsibility of the entry-point so multiple `startHttpServer` calls in a
 * single process (test runners, hot reload) don't stack listeners.
 */
export async function startHttpServer(
  createMcpServer: McpServerFactory,
  { port, authToken, maxSessions }: HttpServerOptions,
): Promise<HttpServerHandle> {
  const maxSessionsResolved = resolveMaxSessions(maxSessions);

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, createMcpServer, transports, authToken, maxSessionsResolved);
    } catch (err) {
      logger.error('HTTP handler error', err);
      // Headers not yet sent → respond cleanly. Already streaming → force-close
      // so the client doesn't hang waiting for the rest of an SSE body.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal server error' }));
      } else if (!res.writableEnded) {
        try { res.end(); } catch { /* best-effort */ }
        try { res.destroy(); } catch { /* best-effort */ }
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const actualPort = (httpServer.address() as AddressInfo).port;

  logger.info(`AEM MCP Server listening on http://0.0.0.0:${actualPort}/mcp`);
  logger.info('Auth: send "Authorization: Bearer <MCP_AUTH_TOKEN>" with each request');
  logger.info(`Max concurrent sessions: ${maxSessionsResolved}`);

  return {
    port: actualPort,
    sessionCount: () => transports.size,
    close: () => closeServer(httpServer, transports),
  };
}

function resolveMaxSessions(maxSessions?: number): number {
  const raw = maxSessions ?? (
    process.env['MCP_MAX_SESSIONS'] !== undefined
      ? Number(process.env['MCP_MAX_SESSIONS'])
      : DEFAULT_MAX_SESSIONS
  );

  if (!Number.isFinite(raw) || raw < 1) {
    throw new Error(
      `Invalid MCP_MAX_SESSIONS value "${maxSessions ?? process.env['MCP_MAX_SESSIONS']}". ` +
      'Provide a positive number.',
    );
  }

  return Math.floor(raw);
}

async function closeServer(
  httpServer: HttpServer,
  transports: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
  await Promise.all(
    [...transports.values()].map((t) => t.close().catch(() => undefined)),
  );
  transports.clear();
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  createMcpServer: McpServerFactory,
  transports: Map<string, StreamableHTTPServerTransport>,
  authToken: string,
  maxSessions: number,
): Promise<void> {
  // ─── CORS ──────────────────────────────────────────────────────────────
  // Echo the Origin so claude.ai (or any MCP client) can call from a browser.
  // We require Authorization, so allow-origin:* with credentials is fine.
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    `Authorization, Content-Type, ${SESSION_HEADER}, mcp-protocol-version, last-event-id`,
  );
  res.setHeader('Access-Control-Expose-Headers', `${SESSION_HEADER}, mcp-protocol-version`);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Parse pathname so /healthz?check=1 etc. routes correctly.
  const pathname = parsePathname(req.url);

  // ─── Health check (no auth) ────────────────────────────────────────────
  if (pathname === '/healthz') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', sessions: transports.size }));
    return;
  }

  // ─── Path routing ──────────────────────────────────────────────────────
  if (pathname !== '/mcp') {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found. POST /mcp with a JSON-RPC body.' }));
    return;
  }

  // ─── Auth ──────────────────────────────────────────────────────────────
  if (!checkAuth(req, authToken)) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Bearer realm="aem-mcp"');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unauthorized. Send Authorization: Bearer <token>.' }));
    return;
  }

  // ─── Body parsing (POST only) ──────────────────────────────────────────
  let body: unknown;
  if (req.method === 'POST') {
    try {
      body = await readJsonBody(req);
    } catch (e) {
      // Don't echo the parser's internal message — it can include bytes from
      // the request body. Log internally and return a stable error.
      logger.warn(`Body parse error: ${e instanceof Error ? e.message : String(e)}`);
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }
  }

  // ─── Resolve session → transport ───────────────────────────────────────
  const sessionId = req.headers[SESSION_HEADER];
  const sessionIdStr = typeof sessionId === 'string' ? sessionId : undefined;

  if (sessionIdStr) {
    const existing = transports.get(sessionIdStr);
    if (!existing) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Unknown or expired session id.' },
      }));
      return;
    }
    await existing.handleRequest(req, res, body);
    return;
  }

  // No session ID. Only `initialize` (POST) is allowed.
  if (req.method !== 'POST' || !isInitializeRequest(body)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message:
          'No active session. Send an "initialize" request first to get an mcp-session-id, ' +
          'then include it as the "mcp-session-id" header on subsequent requests.',
      },
    }));
    return;
  }

  // Capacity check — refuse new sessions when at the soft cap.
  if (transports.size >= maxSessions) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', '60');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message:
          `Server at capacity (${transports.size}/${maxSessions} sessions). ` +
          'Retry in 60s, or close idle sessions via DELETE /mcp with the session id.',
      },
    }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport);
      logger.info(`MCP session initialized: ${id} (${transports.size}/${maxSessions})`);
    },
    onsessionclosed: (id) => {
      transports.delete(id);
      logger.info(`MCP session closed: ${id}`);
    },
  });

  transport.onclose = (): void => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  // Per-session Server instance — required by the MCP SDK (Server.connect()
  // can only attach to one transport).
  const sessionServer = createMcpServer();
  await sessionServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

function parsePathname(url: string | undefined): string {
  if (!url) return '/';
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

function checkAuth(req: IncomingMessage, authToken: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  // Hash both the received header and the expected value to fixed-size 32-byte
  // SHA-256 digests, then compare with timingSafeEqual. This avoids the
  // length-leak that an early "if (a.length !== b.length)" return would cause,
  // and the comparison runs in constant time.
  const expected = `Bearer ${authToken}`;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX_BYTES = 1_000_000; // 1 MB — MCP messages are small
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(raw);
}

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  if (!body || typeof body !== 'object') return false;
  const obj = body as { method?: unknown };
  return obj.method === 'initialize';
}
