# AEM MCP Server Usefulness Validation Matrix

Use one table per environment:

- `AEMaaCS author`
- `Local SDK / AEM 6.5-style author`

Recommended verdict meanings:

- `High`: useful immediately for real operational or content decisions
- `Conditional`: useful, but only with caveats such as missing permissions, sparse content, or async delays
- `Low`: technically works or partially works, but the output is not actionable enough
- `N/A`: intentionally not applicable in that environment

## AEMaaCS Matrix

| Tool | Prompt used | Input values used | Expected behavior | Observed behavior | Usefulness verdict | Reason | Environment caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `aem_system_health` |  |  |  |  |  |  |  |
| `aem_page_property_report` indexed |  |  |  |  |  |  |  |
| `aem_page_property_report` custom property |  |  |  |  |  |  |  |
| `aem_component_usage` sync |  |  |  |  |  |  |  |
| `aem_component_usage` async |  |  |  |  |  |  |  |
| `aem_workflow_audit` |  |  |  |  |  |  |  |
| `aem_workflow_audit` async |  |  |  |  |  |  |  |
| `aem_broken_link_scan` |  |  |  |  |  |  |  |
| `aem_orphaned_assets` |  |  |  |  |  |  |  |
| `aem_msm_livecopy_status` |  |  |  |  |  |  |  |
| `aem_msm_livecopy_status` async |  |  |  |  |  |  |  |
| `aem_audit_log` |  |  |  |  |  |  |  |
| `aem_permission_audit` |  |  |  |  |  |  |  |
| `aem_clientlib_analysis` |  |  |  |  |  |  |  |
| `aem_clientlib_analysis` async |  |  |  |  |  |  |  |
| `aem_job_status` |  |  |  |  |  |  |  |
| `aem_replication_queue` | Do not run on AEMaaCS | N/A | Must be documented as out of scope for AEMaaCS |  | `N/A` |  | Replication agents do not exist in AEMaaCS |

## Local SDK / AEM 6.5-Style Matrix

| Tool | Prompt used | Input values used | Expected behavior | Observed behavior | Usefulness verdict | Reason | Environment caveat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `aem_system_health` |  |  |  |  |  |  |  |
| `aem_system_health` with `platform=aem65` or `platform=aem65lts` |  |  |  |  |  |  |  |
| `aem_page_property_report` indexed |  |  |  |  |  |  |  |
| `aem_page_property_report` custom property |  |  |  |  |  |  |  |
| `aem_component_usage` sync |  |  |  |  |  |  |  |
| `aem_component_usage` async |  |  |  |  |  |  |  |
| `aem_workflow_audit` |  |  |  |  |  |  |  |
| `aem_workflow_audit` async |  |  |  |  |  |  |  |
| `aem_broken_link_scan` |  |  |  |  |  |  |  |
| `aem_orphaned_assets` |  |  |  |  |  |  |  |
| `aem_msm_livecopy_status` |  |  |  |  |  |  |  |
| `aem_msm_livecopy_status` async |  |  |  |  |  |  |  |
| `aem_audit_log` |  |  |  |  |  |  |  |
| `aem_permission_audit` |  |  |  |  |  |  |  |
| `aem_clientlib_analysis` |  |  |  |  |  |  |  |
| `aem_clientlib_analysis` async |  |  |  |  |  |  |  |
| `aem_replication_queue` |  |  |  |  |  |  |  |
| `aem_job_status` |  |  |  |  |  |  |  |

## Quick Review Questions

After filling the matrix, answer these for each environment:

1. Which 3 tools were the most immediately useful?
2. Which tool had the clearest environment limitation?
3. Which async workflow was easiest to operate?
4. Did `aem_page_property_report` remain useful for both indexed and custom-property scans?
5. Would a teammate unfamiliar with the implementation understand how to use these tools from the outputs alone?
