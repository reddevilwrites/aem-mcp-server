# AEM MCP Server Usefulness Validation Playbook

This playbook validates the practical usefulness of the AEM MCP server in two separate environments:

1. `AEMaaCS author`
2. `Local SDK / AEM 6.5-style author`

Use it to answer two questions:

1. Does each tool run successfully in the target environment?
2. Does each tool return output that is useful enough for an AEM engineer, content operator, or site owner to act on?

## How To Use This Playbook

1. Run the baseline discovery prompts for the target environment first.
2. Capture the discovered values for:
   - `<SITE_ROOT>`
   - `<DAM_ROOT>`
   - `<CLIENTLIB_ROOT>`
   - `<COMPONENT_RT>`
   - `<LIVECOPY_ROOT>`
   - `<MASTER_ROOT>`
   - `<AEM_USER>`
3. Replace placeholders in the tool prompts before running them.
4. For async tools:
   - Run the main tool first.
   - Capture the returned `jobId`.
   - Poll `aem_job_status` until the job reaches a terminal state.
5. Record each run in the verification matrix in [usefulness-validation-matrix-template.md](/abs/aem-mcp-server/docs/usefulness-validation-matrix-template.md).

## Environment Defaults

### AEMaaCS

Run discovery first. Do not assume fixed project paths.

### Local SDK

Use these defaults if WKND is installed:

- `<SITE_ROOT>` = `/content/wknd`
- `<DAM_ROOT>` = `/content/dam/wknd`
- `<CLIENTLIB_ROOT>` = `/apps/wknd`
- `<COMPONENT_RT>` = `core/wcm/components/text/v2/text`

If WKND is not present, run the discovery prompts and substitute the real paths.

## AEMaaCS Track

### Baseline Discovery

Copy-paste prompts:

```text
Run `aem_system_health` and summarize whether this is an author environment, what health checks are degraded, and whether there are any access limitations that may affect the other AEM MCP tools.
```

```text
Run `aem_page_property_report` for property `jcr:title` under `/content` with `maxPages=50` and tell me which content subtree looks like the main site root I should use for the rest of the MCP validation.
```

```text
Run `aem_clientlib_analysis` under `/apps` and tell me the most likely project-specific clientlib root to use for follow-up tests.
```

```text
Run `aem_component_usage` with a known common component such as `core/wcm/components/text/v2/text` under `/content` and tell me which site subtree has enough content for meaningful validation.
```

### Targeted Read / Query Tools

#### `aem_page_property_report`

Purpose:
- Validate indexed property reporting
- Validate batched deep scan for non-indexed properties
- Validate MSM-aware scope behavior

Prompts:

```text
Run `aem_page_property_report` for property `cq:template` under `<SITE_ROOT>` with `maxPages=200` and summarize which templates are most used.
```

```text
Run `aem_page_property_report` for property `hideInNav` under `<SITE_ROOT>` with `reportMissing=true` and tell me which pages are missing that governance property.
```

```text
Run `aem_page_property_report` for property `myProject:seoDescription` under `<SITE_ROOT>` with `reportMissing=true` and `maxPages=500`, and tell me whether the tool had to do a batched repository-wide page scan rather than an indexed query.
```

```text
If MSM is present, run `aem_page_property_report` for property `jcr:title` under `<LIVECOPY_ROOT>` with `scope=master`, then again with `scope=livecopy`, and explain the practical difference in output.
```

#### `aem_component_usage`

Purpose:
- Validate component blast-radius reporting
- Validate sync and async result paths

Prompts:

```text
Run `aem_component_usage` for `<COMPONENT_RT>` under `<SITE_ROOT>` and tell me how many pages use it and which top-level sections are most affected.
```

```text
Run `aem_component_usage` for `core/wcm/components/text/v2/text` under `<SITE_ROOT>` with `async=true`, return the job ID, then use `aem_job_status` until results are available and summarize the blast radius.
```

#### `aem_system_health`

Purpose:
- Validate health summary usefulness
- Validate recommendations are actionable

Prompt:

```text
Run `aem_system_health` and summarize the highest-severity issue, the likely operational impact, and the first action an AEM engineer should take.
```

#### `aem_workflow_audit`

Purpose:
- Validate stale and failed workflow reporting
- Validate model-specific filtering

Prompts:

```text
Run `aem_workflow_audit` with `staleThresholdHours=24` and summarize stale or failed workflows by model.
```

```text
Run `aem_workflow_audit` filtered to `/var/workflow/models/dam/update_asset` and tell me whether DAM processing looks healthy.
```

```text
If there are many workflows, rerun `aem_workflow_audit` with `async=true`, then poll `aem_job_status` and summarize the final result.
```

#### `aem_audit_log`

Purpose:
- Validate change tracing value
- Validate user/path/event filtering

Prompts:

```text
Run `aem_audit_log` for `<SITE_ROOT>` over the last `7d` and summarize the most active paths and change types.
```

```text
Run `aem_audit_log` for event type `PageEvent` and user `<AEM_USER>` over the last `24h`, then summarize what that user changed.
```

```text
Run `aem_audit_log` for `AssetEvent` under `<DAM_ROOT>` and tell me whether there was recent bulk asset activity.
```

#### `aem_permission_audit`

Purpose:
- Validate ACL visibility
- Validate dangerous broad-permission detection

Prompts:

```text
Run `aem_permission_audit` for `<SITE_ROOT>` with depth `1` and summarize the allow/deny entries that matter for authors.
```

```text
Run `aem_permission_audit` for `<SITE_ROOT>` filtered to principals `['everyone']` and tell me whether any dangerous broad write permissions exist.
```

```text
Run `aem_permission_audit` on a deeper subtree that editors use daily and explain whether inherited and local ACEs differ in a way that could cause author confusion.
```

#### `aem_clientlib_analysis`

Purpose:
- Validate clientlib architecture diagnostics
- Validate channel-specific analysis

Prompts:

```text
Run `aem_clientlib_analysis` under `<CLIENTLIB_ROOT>` and summarize duplicate categories, circular dependencies, and oversized embeds.
```

```text
Run `aem_clientlib_analysis` under `<CLIENTLIB_ROOT>` with `channel=author`, then compare it with `channel=publish` and explain any practical difference.
```

```text
If the clientlib tree is large, rerun with `async=true`, then use `aem_job_status` and summarize the final result.
```

### Wide-Scan / Async Tools

#### `aem_broken_link_scan`

Purpose:
- Validate site-wide internal-link QA
- Validate async orchestration

Prompts:

```text
Run `aem_broken_link_scan` under `<SITE_ROOT>` with `maxPages=500`, return the job ID, then poll `aem_job_status` until complete and summarize the broken links by page.
```

```text
Run `aem_broken_link_scan` under `<SITE_ROOT>` with extra link properties `['buttonLink','promoLink']`, then compare whether any additional broken links were found.
```

#### `aem_orphaned_assets`

Purpose:
- Validate DAM cleanup candidate reporting
- Validate async orchestration

Prompts:

```text
Run `aem_orphaned_assets` for `<DAM_ROOT>` against content path `<SITE_ROOT>`, return the job ID, then use `aem_job_status` until complete and summarize the top orphaned-asset folders.
```

```text
For the final summary, explicitly note that Experience Fragments, Content Fragments, and external references are not counted, and tell me whether the orphan list is safe enough for manual review.
```

#### `aem_msm_livecopy_status`

Purpose:
- Validate MSM drift reporting
- Validate async fallback for large MSM trees

Prompts:

```text
Run `aem_msm_livecopy_status` under `<SITE_ROOT>` with `outOfSyncOnly=true` and summarize which live copies are out of sync or have inheritance suspended.
```

```text
If MSM is large, rerun `aem_msm_livecopy_status` with `async=true`, then poll `aem_job_status` and summarize the worst live-copy problems.
```

#### `aem_job_status`

Purpose:
- Validate async progress and result retrieval

Prompts:

```text
Use `aem_job_status` for the job ID returned by the previous async tool call and report whether the job is queued, running, completed, or failed.
```

```text
For each async validation, keep polling `aem_job_status` until terminal state, then summarize whether the async tool is operationally usable.
```

#### `aem_job_observability`

Purpose:
- Validate async lifecycle telemetry, checkpoint saves, and pause/resume signals without reading server logs

Prompts:

```text
After an async tool returns a job ID, call `aem_job_observability` with that `jobId` and `includeEvents=true`. Confirm whether the telemetry shows job start, heartbeat/progress, checkpoint saves or `hasCheckpoint`, and terminal completion or failure.
```

```text
For a health-paused async job, call `aem_job_observability` with the job ID and confirm `pauseCount`, `resumeCount`, `hasCheckpoint`, and recent lifecycle events show pause then resume.
```

### Environment-Specific Rule

#### `aem_replication_queue`

Do not run this on AEMaaCS.

Prompt:

```text
Do not run `aem_replication_queue` on this AEMaaCS environment. Instead explicitly document that replication agents are not part of AEM as a Cloud Service and that this tool is intentionally out of scope here.
```

## Local SDK / AEM 6.5-Style Track

### Baseline Discovery

Copy-paste prompts:

```text
Run `aem_system_health` and confirm the local SDK author is reachable and healthy enough for MCP validation.
```

```text
Run `aem_page_property_report` for property `jcr:title` under `/content/wknd` with `maxPages=50` and confirm whether WKND content is installed.
```

```text
Run `aem_clientlib_analysis` under `/apps/wknd` and confirm whether WKND clientlibs are present.
```

```text
Run `aem_component_usage` for `core/wcm/components/text/v2/text` under `/content/wknd` and confirm the sample site has enough content for the remaining tests.
```

### Targeted Read / Query Tools

Reuse the same tool prompts from the AEMaaCS track, but substitute local values such as:

- `<SITE_ROOT>` = `/content/wknd`
- `<DAM_ROOT>` = `/content/dam/wknd`
- `<CLIENTLIB_ROOT>` = `/apps/wknd`

Additional local-only prompt for `aem_system_health`:

```text
On local SDK or a supported 6.5 environment, run `aem_system_health` with platform `aem65` or `aem65lts` and confirm whether JVM or GC diagnostics add anything beyond the Granite health result.
```

### Wide-Scan / Async Tools

Reuse the same prompts from the AEMaaCS track, but with local SDK content roots.

### Environment-Specific Tool

#### `aem_replication_queue`

Purpose:
- Validate replication queue diagnostics on a 6.5-style environment

Prompt:

```text
On local SDK or AEM 6.5 only, run `aem_replication_queue` with `agentType=all` and `includeQueueItems=true`, then summarize blocked agents, queue depth, and failed items.
```

If the local SDK does not expose replication agents in the expected way, record that as an environment caveat rather than marking the server logic useless.

## Failure-Mode and Usefulness Checks

Use these prompts to validate whether outputs remain understandable and useful when the environment is limited.

```text
Run `aem_permission_audit` on a path where access may be restricted and tell me whether the tool fails clearly enough for an operator to understand what permission is missing.
```

```text
Run one async tool on a deliberately large subtree and tell me whether the split between the initial tool response and the later `aem_job_status` polling is understandable enough for a non-author of the MCP server to use.
```

```text
Run `aem_page_property_report` for a custom property that is probably not indexed and explain whether the result still provides enough signal to justify the deep scan cost.
```

## Acceptance Criteria

A tool passes usefulness validation if:

- It returns data that can drive an actual operator or content decision.
- The output is understandable without reading the implementation.
- Async tools can be started and completed through `aem_job_status`.
- Environment limitations are explicit and correct.
- `aem_page_property_report` demonstrates both:
  - a fast indexed case
  - a deeper custom-property scan case
- `aem_replication_queue` is treated as:
  - applicable to local SDK / AEM 6.5-style environments
  - not applicable to AEMaaCS

## Reporting

For every tool run, capture:

- `Prompt used`
- `Input values used`
- `Expected behavior`
- `Observed behavior`
- `Usefulness verdict`: `High`, `Conditional`, or `Low`
- `Reason`
- `Environment caveat`

Use the matrix template in [usefulness-validation-matrix-template.md](/abs/aem-mcp-server/docs/usefulness-validation-matrix-template.md).
