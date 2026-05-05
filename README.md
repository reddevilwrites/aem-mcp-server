# AEM Operations MCP Server

A self-hosted Model Context Protocol (MCP) server for **operating, auditing, and governing** an AEM site through plain-English chat. Find expiring assets, scan for broken links, audit workflows, diff MSM live copies, extend activation windows, and publish - without an AEM developer in the loop.

Dual-path: **AEM as a Cloud Service**, **AEM 6.5**, and **AEM 6.5 LTS**.

---

## Why self-host

**Control.** You own the tool surface. The 14 tools shipped here are a starting point - fork the repo, add a tool that matches your team's actual workflow, deploy. Want a `aem_unpublish_stale_pages` tool that filters by your project's custom property and routes through your approval workflow? It's a 100-line file in `src/tools/`.

**Customisable to your AEM.** Tools branch on `AEM_PLATFORM` (AEMaaCS / 6.5 / 6.5 LTS) so you can ship behaviour that matches your stack. The query-safety framework, async job manager, MSM detection, and per-asset locking are reusable primitives - write a new tool in an afternoon, get the safety layer for free.

**Predictable cost.** Self-hosted on a free-tier PaaS (Render, Fly.io) or a small container in your own infra. The bill is your hosting plan, flat. Run a million asset audits if you want - there's no per-tool-call charge.

**AEM 6.5 / 6.5 LTS coverage.** As of today, Adobe's MCP offerings are scoped to AEM as a Cloud Service. If you operate on-prem AEM 6.5 or AEM 6.5 LTS, this repo is a way to bring agentic operations to those environments - using the same tools, branched per-platform under the hood. *(Verified against Adobe's published documentation; if Adobe ships a 6.5 MCP server later, that's a great day for the ecosystem and you can point your authors at whichever fits your needs.)*

---

## What's inside

15 tools, grouped by purpose:

| Domain | Tools |
|---|---|
| **Asset lifecycle** (write) | `aem_asset_expiry_report`, `aem_extend_asset_expiry` *(with optional publish + per-asset locking + consent flow)* |
| **Content governance** | `aem_component_usage`, `aem_page_property_report` *(MSM-aware)*, `aem_msm_livecopy_status` |
| **Hygiene & audit** | `aem_broken_link_scan`, `aem_orphaned_assets`, `aem_audit_log`, `aem_permission_audit`, `aem_clientlib_analysis`, `aem_workflow_audit` |
| **Operations** | `aem_system_health`, `aem_replication_queue` *(6.5 / AMS only)* |
| **Async polling** | `aem_job_status`, `aem_job_observability` *(read-only diagnostics)* |

Two are write tools - both author-only, both idempotent, both require explicit user consent before publishing.

---

## Quick start (90 seconds)

### Path A - Claude Desktop (stdio, no hosting)

```bash
git clone https://github.com/<you>/aem-mcp-server
cd aem-mcp-server
npm install && npm run build
```

Edit `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aem-ops": {
      "command": "node",
      "args": ["/absolute/path/to/aem-mcp-server/dist/index.js"],
      "env": {
        "AEM_HOST": "http://localhost:4502",
        "AEM_USERNAME": "admin",
        "AEM_PASSWORD": "admin",
        "AEM_PLATFORM": "aemaacs",
        "AEM_INSTANCE": "author"
      }
    }
  }
}
```

Restart Claude Desktop. Type *"What assets are expiring in the next 30 days?"*

### Path B - Docker (HTTP, local network)

```bash
TOKEN=$(node -e "console.log(require('crypto').randomUUID())")

docker build -t aem-mcp-server .
docker run -p 3000:3000 \
  -e AEM_HOST=http://host.docker.internal:4502 \
  -e AEM_USERNAME=admin \
  -e AEM_PASSWORD=admin \
  -e AEM_PLATFORM=aemaacs \
  -e AEM_INSTANCE=author \
  -e MCP_AUTH_TOKEN="$TOKEN" \
  aem-mcp-server

echo "Bearer token: $TOKEN"
echo "MCP endpoint: http://localhost:3000/mcp"
```

### Path C - Render free tier (HTTPS, public URL)

1. Push this repo to GitHub.
2. On Render → New + → **Blueprint** → connect this repo.
3. Render reads `render.yaml`, provisions the service, and prompts for `AEM_HOST` / `AEM_USERNAME` / `AEM_PASSWORD`.
4. Wait for the first deploy. Copy the auto-generated `MCP_AUTH_TOKEN` from the Environment tab.
5. Hit `https://<service>.onrender.com/healthz` to verify.

### Connect from claude.ai

Settings → Connectors → **Add Custom Connector**:

| | |
|---|---|
| URL | `https://<your-host>/mcp` |
| Auth | Bearer token (paste `MCP_AUTH_TOKEN`) |

Done. Try:

- *"List assets expiring in the next 7 days under /content/dam/wknd."*
- *"For these 12 assets, set go-live to 20 May 2026 and publish."* - Claude will ask before publishing.
- *"Which pages don't have a meta description?"*
- *"Audit replication queues."* (6.5 only - the tool will refuse on AEMaaCS with a clear message.)

---

## Configuration

Required:

| Env var | Allowed | Notes |
|---|---|---|
| `AEM_PLATFORM` | `aemaacs` \| `aem65` \| `aem65lts` | Drives platform-aware branching in tools |
| `AEM_HOST` | `https://...` | Author tier endpoint |
| `AEM_USERNAME` / `AEM_PASSWORD` | strings | Service-account credentials |
| `MCP_AUTH_TOKEN` | ≥ 16 chars | **Required for HTTP mode**; stdio mode ignores it |

Optional (all have sensible defaults):

| Env var | Default | Purpose |
|---|---|---|
| `AEM_INSTANCE` | `author` | `author` or `publish`; write tools refuse unless `author` |
| `AEM_CONTENT_ROOT` | `/content` | Default scope for content scans |
| `AEM_DAM_ROOT` | `/content/dam` | Default scope for DAM scans |
| `AEM_QUERY_ASYNC_THRESHOLD` | `500` | Above this candidate count, tools dispatch async |
| `AEM_QUERY_PAGE_SIZE` | `200` | QueryBuilder pagination |
| `AEM_BATCH_DELAY_MS` | `200` | Pause between batches in async tools |
| `AEM_JOB_MAX_CONCURRENT_JOBS` | `2` | Max async MCP jobs running at once; extra jobs stay queued |
| `AEM_JOB_OBSERVABILITY_ENABLED` | `true` | Enable read-only async job telemetry |
| `AEM_JOB_OBSERVABILITY_EVENTS_LIMIT` | `500` | Retained lifecycle events for `aem_job_observability` |
| `MCP_MAX_SESSIONS` | `100` | Cap on concurrent HTTP sessions |
| `PORT` | `3000` | HTTP listen port (Render/Fly inject this) |

See [.env.example](.env.example) for the full list including job-health thresholds.

---

## Architecture highlights

| Layer | File | What's there |
|---|---|---|
| Transport | [src/http-server.ts](src/http-server.ts) | Streamable HTTP per MCP spec; bearer auth with constant-time SHA-256 compare; per-session `Server` instance; capacity cap with 503; CORS for browser-based MCP clients |
| Query safety | [src/query-builder.ts](src/query-builder.ts) | Enforces non-empty absolute path, type constraints; static index analysis with 7 prioritised rules; optional runtime explain-plan validation |
| Async jobs | [src/job-manager.ts](src/job-manager.ts) | In-memory queue with checkpoint/resume; health-aware pause via `assessLongRunningJobHealth`; TTL cleanup including stuck paused jobs; read-only telemetry via `aem_job_observability` |
| Per-asset locking | [src/utils/asset-lock.ts](src/utils/asset-lock.ts) | FIFO serialisation for concurrent writers on the same DAM asset; different assets run in parallel |
| Platform branching | [src/config.ts](src/config.ts) + tools | AEMaaCS / 6.5 / 6.5 LTS handled per-tool, never assumed |

---

## Building your own tools

Adding a tool is intentionally low-ceremony. The full recipe:

1. Drop a new file in `src/tools/` exporting an async function.
2. Use `queryBuilder.query(...)` for any JCR query - you get path/type enforcement and index warnings free.
3. Use `jobManager.start(...)` if it could take more than a few seconds - checkpoint/resume + health-aware pause are wired in.
4. For write tools: call `assertAuthorInstance(...)` first, wrap mutations in `withAssetLock(assetPath, ...)`, default destructive flags to `false`.
5. Register the tool in `src/index.ts` - input schema, dispatcher, done.
6. Write a unit test in `tests/unit/` mocking `aemClient` + `queryBuilder`.

A representative example: [src/tools/asset-expiry.ts](src/tools/asset-expiry.ts) - author-only guard, two-phase update + publish, batched async with checkpoint resume, per-asset locking, structured per-item failure reporting. ~400 lines.

---

## Limitations and roadmap

This is a demo-grade build. The following are **explicitly out of scope today** and tracked here so you know what production would actually require:

- **Auth:** demo-grade bearer token. Production should use OAuth 2.1 + PKCE per the MCP spec (Auth0 / Okta / Clerk free tiers all work).
- **Per-user identity to AEM:** today the server uses one shared service account. Production should propagate the OAuth subject to AEM (impersonation header on AEMaaCS, group-scoped service users on 6.5).
- **Persistent job state:** in-memory only. A free-tier instance that sleeps loses async job results. Upstash Redis (free tier - 10k reqs/day) covers this.
- **Multi-replica deployment:** the per-asset lock is in-process. For horizontal scaling, swap for Redis advisory locks.
- **Sling Content Distribution:** the publish path uses `/bin/replicate.json`, which works on AEMaaCS author for backward compat but is the legacy API. Migration to the supported SCD endpoint is on the roadmap.
- **MCP elicitation primitive for consent:** today `publish: true` relies on the LLM remembering to ask for consent. Production should use the MCP server-to-client elicitation primitive so consent is server-enforced.
- **Pre-execution explain-plan validation:** captured as 12 `it.todo` items in `tests/unit/page-property-report.production-safety.test.ts`. Each is a small, demoable PR.

---

## Development

```bash
npm install
npm run build         # tsc to dist/
npm run watch         # auto-rebuild on src/**/*.ts changes
npm start             # builds + starts in stdio mode
node dist/index.js --http --port=3000   # HTTP mode (requires MCP_AUTH_TOKEN)
npm run test:unit     # unit tests
npm run test:e2e      # integration tests (some require a live AEM at AEM_HOST)
```

Test count today: **151 passing**, 12 `it.todo` items documenting planned production-safety hardening.

---

## License

MIT. Use it, fork it, ship it.
