# AGENTS.md

## Purpose

This repository contains an MCP server for Adobe Experience Manager (AEM). It exposes operational-audit and content-governance tools (read-heavy, with two carefully-scoped write tools for asset lifecycle) over stdio AND a remote Streamable HTTP transport, using the Model Context Protocol.

Current product direction:

- Operational-audit niche — complementary to Adobe's hosted authoring MCP fleet and Adobe's local Java dev-loop quickstart, not a replacement for either.
- AEMaaCS + AEM 6.5 + 6.5 LTS dual-path. Platform branching is explicit, never assumed.
- Query-safe by default — every JCR query routes through a wrapper that enforces path/type constraints and surfaces index warnings.
- Async for expensive operations, with checkpoint/resume and health-aware pausing.
- Operationally conservative for long-running work.
- Author-instance only for write tools. Demo-grade auth (bearer token) on the HTTP transport with a clearly-documented OAuth roadmap.

This file is intended for coding agents and maintainers. It documents what exists today, the architectural constraints, and the rules that should govern future changes.

## Current Scope

The server currently exposes 15 tools. Two are write-tier (`aem_extend_asset_expiry`, `aem_extend_asset_expiry`'s optional publish phase via `/bin/replicate.json`); the rest are read-only.

1. `aem_component_usage`
2. `aem_system_health`
3. `aem_workflow_audit`
4. `aem_broken_link_scan`
5. `aem_orphaned_assets`
6. `aem_msm_livecopy_status`
7. `aem_audit_log`
8. `aem_permission_audit`
9. `aem_clientlib_analysis`
10. `aem_page_property_report`
11. `aem_replication_queue` *(AEM 6.5 / AMS only)*
12. `aem_asset_expiry_report`
13. `aem_extend_asset_expiry` *(write — author only — optional publish with consent flag)*
14. `aem_job_status`
15. `aem_job_observability`

These are defined and dispatched from [src/index.ts](src/index.ts). The tool factory `createMcpServer()` in the same file is required by the HTTP transport — the MCP SDK's `Server.connect()` can only attach to one transport per instance, so each new HTTP session creates a fresh Server.

## Runtime Model

- Entry point: `dist/index.js`
- Source of truth: `src/**/*.ts`
- Build output: `dist/`
- Transports: **stdio** (default, for Claude Desktop / Cursor / local dev) AND **Streamable HTTP** (`--http` flag, for remote MCP clients like claude.ai Custom Connectors)
- Package type: native ESM
- Runtime target: Node 18+ (Node 20+ for the Docker image)

Mode selection:

- `node dist/index.js` — stdio mode, no auth (CLI trust)
- `node dist/index.js --http [--port=3000]` — HTTP mode; **requires `MCP_AUTH_TOKEN` ≥ 16 chars**; refuses to start otherwise
- `PORT` env var also honoured (Render / Railway / Fly inject it)
- `MCP_MAX_SESSIONS` (default 100) caps concurrent HTTP sessions; over-cap `initialize` calls get **HTTP 503 + Retry-After: 60**

Important:

- The server runs compiled output from `dist`, not TypeScript directly from `src`.
- `npm start` triggers `prestart`, which runs a build first.
- A TypeScript watcher is configured so local edits should keep `dist` up to date.
- The Docker image (`Dockerfile`) defaults to HTTP mode with a non-root user and a `/healthz`-based healthcheck. `render.yaml` provisions a Render free-tier service with `MCP_AUTH_TOKEN` auto-generated.
- For any AEMaaCS-related functionality, check the official documentation — [aemaacs](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service)
- For AEM 6.5 — [aem65](https://experienceleague.adobe.com/en/docs/experience-manager-65)
- For AEM 6.5 LTS — [aem65lts](https://experienceleague.adobe.com/en/docs/experience-manager-65-lts)

Relevant files:

- [package.json](package.json)
- [tsconfig.json](tsconfig.json)
- [Dockerfile](Dockerfile) + [.dockerignore](.dockerignore)
- [render.yaml](render.yaml)
- [.env.example](.env.example)
- [.vscode/tasks.json](.vscode/tasks.json)
- [.vscode/settings.json](.vscode/settings.json)

## High-Level Architecture

### 1. MCP server surface

[src/index.ts](src/index.ts) is the single registry for:

- tool metadata
- input schemas
- tool dispatch
- the `createMcpServer()` factory (HTTP transport requires one Server per session)
- stdio + HTTP transport startup, signal-handler wiring

If a tool is implemented but not wired here, it does not exist from the MCP client's perspective.

### 2. HTTP transport + auth

[src/http-server.ts](src/http-server.ts) wraps Node's built-in `http` server and exposes:

- `POST /mcp` — JSON-RPC entry-point, requires `Authorization: Bearer <MCP_AUTH_TOKEN>`
- `GET /mcp` — server-to-client SSE for streamed responses (per MCP spec)
- `DELETE /mcp` — graceful session close
- `OPTIONS /mcp` — CORS preflight
- `GET /healthz` — unauthenticated, used by Render / Fly / Docker liveness probes

Auth implementation:

- Bearer-token comparison uses `crypto.timingSafeEqual` over fixed-size SHA-256 digests of the received header and the expected value. This avoids both length-leak and non-constant-time character comparison.
- Sessions are tracked in a `Map<sessionId, transport>`. The map is bounded by `MCP_MAX_SESSIONS` (default 100). Over-cap `initialize` requests get HTTP 503 with `Retry-After: 60` — refusal, not eviction, so spammers can't displace legitimate users.
- `startHttpServer` returns an `HttpServerHandle` with a `close()` method. Signal handlers (`SIGTERM`/`SIGINT`) are registered in `index.ts`, NOT inside `startHttpServer`, so test runners or hot-reload don't stack listeners.

CORS:

- Echoes `Origin`, allows `POST/GET/DELETE/OPTIONS`, exposes `mcp-session-id` and `mcp-protocol-version`. Works with claude.ai Custom Connectors out of the box.

Demo-grade caveat:

- The bearer-token model is a single shared secret. Production should swap this for OAuth 2.1 + PKCE per the MCP spec — the rest of the transport layer is unchanged.

### 3. AEM access layer

The repo uses a shared AEM HTTP client in [src/aem-client.ts](src/aem-client.ts) and shared configuration in [src/config.ts](src/config.ts).

Configuration includes:

- `AEM_HOST`, `AEM_USERNAME`, `AEM_PASSWORD`
- `AEM_PLATFORM` (mandatory)
- `AEM_INSTANCE` (`author` | `publish`, default `author` — write tools refuse unless `author`)
- `AEM_CONTENT_ROOT`, `AEM_DAM_ROOT`
- `MCP_AUTH_TOKEN`, `MCP_MAX_SESSIONS`, `PORT` (HTTP mode)
- query thresholds, page sizes, batch delays
- long-running job health thresholds

### 4. Platform-aware behavior

[src/config.ts](src/config.ts) defines the platform contract:

- `aemaacs`
- `aem65`
- `aem65lts`

Current strategy:

- `AEM_PLATFORM` is mandatory
- Allowed values are exactly `aemaacs`, `aem65`, and `aem65lts`
- The server does not auto-detect platform
- Tool behavior must branch from the configured or explicitly supplied platform value

### 5. Query safety layer

[src/query-builder.ts](src/query-builder.ts) is a core abstraction in this codebase. Its safety guarantees are the headline differentiator from Adobe's MCP servers.

It provides:

- safe QueryBuilder access
- required path constraints — **the path must be a non-empty absolute string starting with `/`**. Empty / whitespace / non-string / relative path values are rejected up-front. This closes the "key exists but is unusable" hole.
- type-constraint warnings when missing or set to `nt:base`
- paginated result fetching
- count operations
- static index coverage warnings (7 prioritised rules: `nt:base` flagged, missing-type warnings, wrong-index post-filter, unindexed property post-filter, orderby on non-indexed, high-limit + unindexed combo, evaluatePathRestrictions hint)
- optional runtime explain-plan analysis via the AEM Explain Query servlet

This layer exists specifically to avoid unsafe traversal-prone querying.

### 6. Async job layer

[src/job-manager.ts](src/job-manager.ts) manages long-running operations in memory.

It provides:

- queued background execution
- progress reporting
- checkpointing (callers store arbitrary resume state via `ctx.heartbeat({ checkpoint })`)
- pause/resume behavior keyed by `PauseJobError` from heartbeat
- TTL-based cleanup, including a longer ceiling for stuck `paused` jobs (max 6h) so they don't leak forever
- polling via `aem_job_status`

Job statuses:

- `pending`
- `running`
- `paused`
- `completed`
- `failed`

### 7. Runtime health guard

Long-running jobs use [src/tools/system-health.ts](src/tools/system-health.ts) as an execution guard.

The job manager heartbeats periodically and may pause jobs when the instance appears under pressure.

Current signals include:

- author responsiveness probe latency
- Sling Jobs queue pressure
- JMX heap usage on AEM 6.5 / AMS
- failed job counts

### 8. Per-asset write locking

[src/utils/asset-lock.ts](src/utils/asset-lock.ts) provides FIFO, per-asset-path serialisation for concurrent writers.

Why:

- Multiple MCP sessions running concurrently in the same server process must not write to the same DAM asset at the same time. AEM's Sling POST has no opportunistic-locking semantics by default; without serialisation, two sessions racing to extend the same asset's `offTime` can silently overwrite each other.

API:

- `withAssetLock(assetPath, fn)` — runs `fn` under a per-path lock, queues subsequent callers FIFO.
- `withAssetLockMeta(assetPath, fn)` — same plus `{ waited, waitedMs }` so tools can surface contention to users.

Scope and limits:

- In-process only. Multi-replica deployments need a Redis / Postgres advisory lock. This is on the roadmap.
- Different paths run fully in parallel.
- A throwing holder still releases the lock; the queue is not blocked by failure.
- Wrapped around `updateAssetActivationWindow` in `aem_extend_asset_expiry`'s phase-1 update loop. Phase 2 (replication) does not acquire the lock — replication is idempotent so concurrent activates are harmless.

## Tools Built So Far

### `aem_component_usage`

Purpose:

- Find pages using a given `sling:resourceType`

Behavior:

- Query-safe
- Async above threshold
- Intended to rely on indexed `sling:resourceType`

### `aem_system_health`

Purpose:

- Summarize current AEM runtime health

Behavior:

- Platform-aware dual path
- For AEMaaCS: uses author responsiveness and accessible runtime status endpoints only
- For AEM 6.5 / AMS: additionally inspects JMX memory, GC, Sling Jobs, and error log tail
- No longer uses `/system/health.json`

Important recent fix:

- `src/tools/system-health.ts` had already been modernized, but the running server still used stale compiled code in `dist`
- Repo now has stronger safeguards to keep `dist` current during development

### `aem_workflow_audit`

Purpose:

- Identify stale and failed workflow instances

Behavior:

- Supports async offload for large result sets

### `aem_broken_link_scan`

Purpose:

- Scan pages for broken internal links

Behavior:

- Always async
- Intended for large subtree analysis

### `aem_orphaned_assets`

Purpose:

- Identify DAM assets that are not referenced by pages

Behavior:

- Always async
- Two-pass design: collect page references, then diff against DAM assets

### `aem_msm_livecopy_status`

Purpose:

- Report MSM live-copy sync issues and inheritance problems

Behavior:

- MSM-oriented analysis
- Async for large trees

### `aem_audit_log`

Purpose:

- Query Granite audit activity with filters

Behavior:

- Supports path, user, date, and event-type filtering

### `aem_permission_audit`

Purpose:

- Read ACL information on a JCR path

Behavior:

- Read-only
- Designed to work in AEMaaCS subject to service-user visibility

### `aem_clientlib_analysis`

Purpose:

- Inspect AEM client libraries for duplicate categories, circular dependencies, and large embeds

Behavior:

- Async for larger scopes

### `aem_page_property_report`

Purpose:

- Report pages where a `jcr:content` property exists, is missing, or matches a value

Current behavior:

- MSM-aware
- Supports `scope=master|livecopy|all`
- Uses indexed QueryBuilder fast path for known indexed properties
- Uses batched in-memory scanning for non-indexed properties
- For `jcr:title`, value filtering uses property-scoped fulltext rather than leading-wildcard `LIKE`
- For non-text indexed properties, matching remains exact
- For non-indexed properties, fallback matching may use in-memory substring checks

MSM master-root detection:

- The standard AEM MSM layout is `/content/<project>/(language-masters | <countryCode>)/<languageCode>[/...]`.
- `trimToMasterRoot` matches this structurally (regex) instead of using a fragile path-segment count, and supports locale-suffixed codes (`en_US`, `en-GB`).
- Non-standard layouts (extra leading segments, missing language code, paths outside `/content`) return `undefined` and the caller falls back to the supplied `rootPath` — correct, just possibly broader than ideal.

Important recent improvements:

- The tool now includes pages like `WKND Adventure` when filtering `jcr:title` by `WKND`. This was reworked to align with Adobe query/indexing guidance — https://experienceleague.adobe.com/en/docs/experience-manager-learn/foundation/development/understand-indexing-best-practices
- MSM master-root heuristic replaced (was: hard-coded `slice(0, 5)` on the path segments — broke on non-standard layouts).

### `aem_replication_queue`

Purpose:

- Diagnose replication-agent queue state

Constraint:

- AEM 6.5 / AMS only
- Must not be presented as supported on AEMaaCS

### `aem_asset_expiry_report`

Purpose:

- Find DAM assets whose `offTime` falls within the next N days. Returns up to 10 soonest-expiring assets plus the total count when more exist.

Behavior:

- Author-instance only (refuses if `AEM_INSTANCE != 'author'`)
- Enumerates `dam:Asset` paths via QueryBuilder, then fetches each asset's `jcr:content` to read `offTime` in-memory. The QueryBuilder `daterange` and `property.operation=exists` predicates are unreliable against `jcr:content/offTime` on `dam:Asset` (see comment in `src/tools/asset-expiry.ts`).
- Tolerant of multiple `offTime` storage formats (JCR Date, ISO 8601 String, JS `Date.toString()` form like `"Sun May 10 2026 23:33:00 GMT+0530"`).
- Sorted by soonest expiry first.

### `aem_extend_asset_expiry` *(WRITE — author only)*

Purpose:

- Update the activation window (`onTime` / `offTime`) of one or more DAM assets, optionally publish them.

Behavior:

- Targets either by explicit `assetPaths` or by `withinDays` filter under `damPath`.
- Mutations: `extendByDays` (relative, falls back to "now" when no existing `offTime`), `newOffTime` (absolute), `newOnTime` (absolute go-live date).
- Two-phase async job: phase 1 = property updates via Sling POST with `@TypeHint=Date`; phase 2 = optional replication via `/bin/replicate.json` (`cmd=Activate`) per asset.
- Per-asset lock (see Architecture §8) serialises concurrent same-asset writers across MCP sessions.
- Per-asset failure isolation — a 403 on one asset doesn't fail the batch.
- `publish: true` requires explicit user consent; the calling agent MUST ask the user before setting it. Documented in the tool description for the LLM.
- `failedReplicationPaths[]` and `items[].replicationError` are returned on partial failure so users can re-target or retry.
- `dryRun: true` short-circuits both phases for previewing.

Constraints:

- `extendByDays` ⊕ `newOffTime` (mutually exclusive)
- `newOnTime` independent — can be combined with either of the above, but per-asset ordering check rejects when `newOnTime > newOffTime` (or `newOnTime > existing offTime`).

### `aem_job_status`

Purpose:

- Poll progress and results of async jobs

Behavior:

- Core usability tool for long-running scans
- Must remain understandable to non-authors of this codebase

### `aem_job_observability`

Purpose:

- Inspect read-only in-memory telemetry for async jobs so maintainers can verify lifecycle, heartbeat, checkpoint, pause/resume, completion, failure, and cleanup behavior without reading logs.

Behavior:

- Diagnostic only; not a replacement for `aem_job_status`
- Supports filtering by `jobId` and `toolName`, optional recent lifecycle events, and a bounded in-memory event buffer
- Does not expose checkpoint payload contents, AEM credentials, request bodies, or page/asset data

## Development Rules

### Adobe documentation is authoritative

For AEM best practices and anti-patterns, validate against official Adobe documentation first.

This is not optional for:

- query design
- Oak index usage
- fulltext vs property restriction tradeoffs
- MSM behavior
- replication assumptions
- workflow behavior
- AEMaaCS operational limitations

Do not invent AEM "best practices" from memory when an official Adobe source should be checked.

### Query design rules

These are core project rules.

1. Always prefer indexed queries over traversal-prone scans.
2. Every QueryBuilder query must include a path restriction.
3. Prefer a type restriction whenever possible.
4. If a property is not known to be indexed, either:
   - warn and batch safely
   - or move the work to async execution
5. Avoid leading-wildcard strategies like `%value%` when they conflict with AEM/Oak best practices.
6. Use property-scoped fulltext only where Adobe guidance and index behavior make that appropriate.
7. Surface index warnings rather than silently issuing risky queries.

### AEMaaCS vs AEM 6.5 / AMS rules

Do not assume parity between platforms.

Examples:

- Replication agents are not part of AEMaaCS
- JMX access differs significantly
- Deep runtime inspection differs significantly
- Author-only endpoints may not exist or may be restricted

When a feature is unsupported on AEMaaCS, say so clearly and return a precise caveat.

### Async job rules

Use the async job pattern when a tool:

- scans large trees
- fetches many nodes
- can exceed normal MCP response expectations
- benefits from checkpointing

Async tools should:

- return quickly with a job ID
- provide a useful polling message
- preserve progress where practical
- heartbeat often enough for health-based pausing

### Output quality rules

Tool results should be:

- readable by non-authors of the server
- explicit about caveats
- clear about platform assumptions
- actionable when reporting warnings or degraded status

## Testing and Validation

Current test layout:

- `tests/unit`
- `tests/integration`

Known test files include:

- [tests/unit/query-builder.warnings.test.ts](tests/unit/query-builder.warnings.test.ts) — 7 index-warning rules + path-safety enforcement (empty / whitespace / relative / non-string)
- [tests/unit/page-property-report.test.ts](tests/unit/page-property-report.test.ts) — fast/slow path selection + `trimToMasterRoot` MSM heuristic
- [tests/unit/page-property-report.production-safety.test.ts](tests/unit/page-property-report.production-safety.test.ts) — async dispatch thresholds + 12 `it.todo` entries documenting deferred pre-execution explain-plan validation
- [tests/unit/asset-expiry.test.ts](tests/unit/asset-expiry.test.ts) — author-only guard, validation, two-phase update+publish, checkpoint resume, per-asset lock integration
- [tests/unit/asset-lock.test.ts](tests/unit/asset-lock.test.ts) — same-path serialisation, different-path parallelism, throw-then-recover, FIFO queue, wait metrics, map cleanup
- [tests/integration/query-builder.e2e.test.ts](tests/integration/query-builder.e2e.test.ts) — live AEM, all 7 warning rules, count/queryAll consistency
- [tests/integration/explain-query.e2e.test.ts](tests/integration/explain-query.e2e.test.ts) — Explain Query servlet behaviour
- [tests/integration/http-server.e2e.test.ts](tests/integration/http-server.e2e.test.ts) — Streamable HTTP transport, bearer auth, CORS preflight, session lifecycle, capacity cap, body limits

Test count today: **151 passing** + 12 `it.todo` (deferred production-safety items).

Validation docs exist in:

- [docs/usefulness-validation-playbook.md](docs/usefulness-validation-playbook.md)
- [docs/usefulness-validation-matrix-template.md](docs/usefulness-validation-matrix-template.md)

When changing behavior:

1. Update unit tests for the changed semantics.
2. Rebuild `dist`.
3. Prefer targeted integration checks when endpoint behavior changes.
4. If the change touches AEM querying/indexing behavior, verify against official Adobe docs.
5. If the change touches the HTTP transport, the auth path, or the per-asset lock — add a corresponding integration / unit test. These are the security-relevant surfaces.

## Local Development Workflow

Recommended commands:

- `npm run build`
- `npm run watch`
- `npm start`
- `npm run test:unit`
- `npm run test:e2e`

Important details:

- `npm start` builds before launching
- `npm run watch` keeps `dist` updated as `src/**/*.ts` changes
- VS Code task automation is configured to start the watcher on folder open

## Known Design Constraints

1. **Async jobs are in-memory only.** Process restarts lose pending job state. A Render free-tier instance that sleeps loses async results. Roadmap: Upstash Redis (free tier, 10k req/day).

2. **Platform selection is explicit.** `AEM_PLATFORM` is required and must match the target environment.

3. **Some AEMaaCS runtime internals are intentionally not treated as directly queryable.** The server should be honest about these limits.

4. **The tool surface is mostly read-oriented**, with two carefully-scoped write tools (`aem_extend_asset_expiry` — author-only — and its optional publish phase). New write tools must:
   - require `AEM_INSTANCE === 'author'` (use `assertAuthorInstance`)
   - take a `dryRun` flag
   - acquire the per-asset lock around mutations on the same JCR path
   - require explicit user consent for any side-effect visible to publish consumers (the LLM is told to ask the user before passing `publish: true`)

5. **Per-asset lock is in-process.** Multi-replica deployments need a Redis / Postgres advisory lock. Single-replica is fine for the demo and free-tier.

6. **Demo-grade auth on HTTP transport.** Bearer-token comparison is timing-safe but the model is a single shared secret. Production should swap for OAuth 2.1 + PKCE per the MCP spec.

7. **`/bin/replicate.json` is the legacy path.** Works on AEMaaCS author for backward compatibility; Sling Content Distribution is the supported API going forward. Migration is on the roadmap.

8. **One Server per HTTP session.** The MCP SDK's `Server.connect()` can only attach to one transport per instance, so HTTP mode uses the `createMcpServer()` factory in `src/index.ts` to spin up a fresh Server per session. Tool definitions are stateless; stateful objects (`jobManager`, `aemClient`) remain process-wide singletons.

## Preferred Change Strategy

When adding or modifying a tool:

1. Start from the AEM platform constraints.
2. Check official Adobe docs if best-practice behavior is involved.
3. Decide whether the operation should be sync or async.
4. Route through `queryBuilder` if querying repository content. Path constraint must be a non-empty absolute string.
5. Emit explicit warnings for index risk or unsupported platform behavior.
6. For write tools: enforce author-only via `assertAuthorInstance`; wrap per-asset mutations in `withAssetLock`; default destructive flags to `false` and require explicit consent.
7. Add or update unit tests, including a regression test if you're fixing a bug.
8. Rebuild `dist`.

## Immediate Opportunities

These are reasonable next improvements based on the current codebase:

- **Pre-execution explain-plan validation** in `aem_page_property_report` — captured as 12 `it.todo` items; each is a small, demoable PR.
- **OAuth 2.1 + PKCE** to replace bearer-token auth. Auth0 / Clerk free tiers fit.
- **Redis-backed job manager** so jobs survive restarts and horizontal scale becomes possible.
- **Per-user identity propagation** to AEM (impersonation header on AEMaaCS, group-scoped service users on 6.5).
- **MCP elicitation primitive** for `publish: true` consent so the server enforces confirmation rather than trusting the LLM.
- **Sling Content Distribution** migration for the publish phase of `aem_extend_asset_expiry`.
- **Distinguishing 403 vs 404** in `aemClient.pathExists` (currently collapsed) — matters for ACL-aware tooling like `aem_permission_audit` and `aem_orphaned_assets`.
- **Author-friendly tool description rewrite** — drop "QueryBuilder", "Oak", "MSM" jargon from the schema descriptions exposed to the LLM.
- **Add explicit match-mode options** to `aem_page_property_report` instead of inferring behavior from property type.
- **More structured result schemas** for clients that want deterministic parsing.

## Summary

This repository is more than a simple MCP wrapper. It contains:

- a platform-aware AEM operational-audit surface (14 tools, 7 audit domains, dual-path AEMaaCS / 6.5 / 6.5 LTS)
- a safety-oriented query abstraction with enforced path constraints, static index analysis, and optional runtime explain-plan validation
- an async execution model with checkpoint/resume and health-based throttling
- MSM-aware and AEMaaCS-aware tool behavior, with per-tool platform branching (no "best-effort" assumptions)
- per-asset write locking that serialises concurrent mutations across MCP sessions
- a remote Streamable HTTP transport with bearer-token auth, CORS, capacity cap, and per-session Server isolation
- an explicit preference for operational honesty over pretending unsupported AEM features exist

The product positioning is **complementary** to Adobe's MCP servers, not competitive: Adobe's hosted fleet covers authoring CRUD; Adobe's local quickstart covers Java dev-loop debugging; this server covers operations and governance — the layer Adobe didn't build.

Future work should preserve those qualities.
