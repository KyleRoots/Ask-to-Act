---
name: AskToAct MCP API key for cloud agents
description: How agents call connect.asktoact.ai via ASKTOACT_MCP_API_KEY without embedding secrets in the repo.
---

# Cloud agents: call AskToAct MCP with `ASKTOACT_MCP_API_KEY`

**Rule:** Agents that need live Bullhorn data must call the deployed AskToAct MCP
endpoint using the secret env var `ASKTOACT_MCP_API_KEY` — never hardcode tokens
in source, commits, or agent transcripts.

**Where to set it:** Cursor → Cloud Agents → **Secrets** → add
`ASKTOACT_MCP_API_KEY`. Prefer **Runtime Secret** so the value is redacted from
tool output and commits. Restart the cloud agent after adding.

**What value to use:**

| Use case | Put in `ASKTOACT_MCP_API_KEY` |
|----------|------------------------------|
| Ops health, note-snapshot admin, headless reads, cloud-agent smokes | Production **service** `MCP_BEARER_TOKEN` |
| Recruiter writes / per-user attribution | That recruiter’s portal **user api_key** |

Both authenticate MCP `/api/mcp` and REST `/api/v1`. Prefer the **service bearer**
in Cursor Secrets for ops and automation so one secret covers tools **and**
ops-health (see gotcha below).

**Optional:** `ASKTOACT_MCP_BASE_URL` (default `https://connect.asktoact.ai`).

### Ops-health auth gotcha

`GET /api/internal/ops-health` (and `ops-agent-notify`) accept **only**:

- production `MCP_BEARER_TOKEN` (service), or
- dedicated `OPS_HEALTH_SECRET`

A **portal user apiKey** that works for MCP tools returns
`403 Forbidden: invalid ops credentials`. If
`pnpm --filter @workspace/scripts ops-health` fails with that message, the Cursor
secret is a user key — set `OPS_HEALTH_SECRET` (preferred) or replace
`ASKTOACT_MCP_API_KEY` with the service bearer for ops runs.

See [ops-alerts.md](./ops-alerts.md).

**How to call (preferred — keeps the secret in the shell, not agent context):**
```bash
pnpm --filter @workspace/scripts asktoact-mcp describe_entity Candidate
pnpm --filter @workspace/scripts asktoact-mcp call describe_entity '{"entityType":"Candidate"}'
```

Parse `configuredCustomFields` from the JSON for label → API name mapping.

**Raw curl (same auth):**
```bash
curl -sS -X POST "$ASKTOACT_MCP_BASE_URL/api/mcp" \
  -H "Authorization: Bearer $ASKTOACT_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"describe_entity","arguments":{"entityType":"Candidate"}}}'
```

**Why a dedicated env name:** `MCP_BEARER_TOKEN` is the *server's* gate secret on
Replit/production. Cloud agents are *clients* calling that server — a distinct name
avoids confusion and lets agents hold a user api_key without implying server config.
