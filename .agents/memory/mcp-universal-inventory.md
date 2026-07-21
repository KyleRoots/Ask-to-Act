---
name: mcp-universal-inventory
description: One universal MCP connector keeps all read+write tools; registration priority + description budget fight ChatGPT tools/list truncation without splitting capability.
---

# Universal MCP inventory (no core/full tiers)

AskToAct is **one connector**: full ATS retrieve / write / update / delete on a single URL.

## Truncation mitigation (not capability splitting)

ChatGPT may truncate long `tools/list` payloads. We do **not** solve that with a read-only `?tier=core` URL.

Instead:

1. **Registration priority** — `MCP_TOOL_PRIORITY` in `mcp-server.ts` registers high-value tools first (`list_reports`, `scout_dept_report`, reports, search/match, gets, then writes, destructives last).
2. **Description budget CI** — `mcp-inventory-budget.test.ts` fails if sum of tool descriptions exceeds `MCP_DESCRIPTION_BUDGET_CHARS`.
3. **Description diet** — shorten tool copy; never remove tools for budget.

## Scout / screening generality

`scout_dept_report` defaults to ScoutGenius note actions but accepts any `noteAction`. Plumbing is department → applicants → notes. A future generic alias + firm-configured default actions can rebrand without a second connector.

## Related

- [scout-qualified-by-department.md](./scout-qualified-by-department.md)
