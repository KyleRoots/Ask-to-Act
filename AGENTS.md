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

## GTM materials access (exec-summary, pitch-deck)

Customer Brief, Exec Summary, and Pitch Deck are **not public** in production unless explicitly opened.

- Set **`GTM_MATERIALS_PASSWORD`** on Railway (required for access after deploy).
- Optional **`GTM_MATERIALS_USER`** (default `asktoact`). Share both with anyone you grant access.
- Without the password in production → `/exec-summary` and `/pitch-deck` return **404**.
- GTM playbook (`.agents/memory/gtm-pricing-2026.md`, `lib/gtm/`) is **repo-only** — never web-served.

See: `.agents/memory/gtm-pricing-2026.md` (access control section).
