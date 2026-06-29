# Agent instructions (AskToAct repo)

## Live Bullhorn access via AskToAct MCP

To query Bullhorn through the deployed connector (search, `describe_entity`, reports, writes), use the **AskToAct MCP API**, not direct Bullhorn credentials.

### 1. Add the secret (one-time, in Cursor)

1. Open [Cursor Cloud Agents → Secrets](https://cursor.com/dashboard/cloud-agents).
2. Add a secret named **`ASKTOACT_MCP_API_KEY`**.
3. Set the value to either:
   - the production **service bearer token** (`MCP_BEARER_TOKEN`), or
   - a **portal user API key** (enrolled recruiter — required for write tools).
4. Use secret type **Runtime Secret** so the key is redacted from logs and commits.
5. Restart the cloud agent after saving.

Optional: **`ASKTOACT_MCP_BASE_URL`** — defaults to `https://connect.asktoact.ai`.

### 2. Call MCP tools from the agent VM

```bash
# List tools
pnpm --filter @workspace/scripts asktoact-mcp tools/list

# Entity field discovery (custom-field labels → API names)
pnpm --filter @workspace/scripts asktoact-mcp describe_entity Candidate
```

The `describe_entity` response includes `configuredCustomFields`: admin-configured
custom fields with human-readable `label` and opaque Bullhorn `name` (e.g.
`customText3` → "Internal Department").

### 3. Do not commit secrets

Never put API keys in `.env` files committed to git. Use Cursor Secrets only.

See also: `.agents/memory/asktoact-mcp-api-key.md`.
