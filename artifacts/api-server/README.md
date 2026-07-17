# Bullhorn ATS MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server that connects **ChatGPT, Claude, Gemini, and Grok** to **Bullhorn ATS**. Recruiters can search, read, and write back to Bullhorn directly from their AI chat — adding notes, updating statuses, submitting candidates, and creating placements — without ever leaving the chat.

This is pure middleware. No UI, no user login screens. ChatGPT calls this server silently in the background.

---

## Architecture

```
ChatGPT / Claude / Gemini / Grok  ──►  This MCP Server  ──►  Bullhorn REST API
   (recruiter toggle)                 (hosted on Replit)          (your ATS data)
```

All requests from ChatGPT must include a shared bearer token. Requests without the token are rejected with `401 Unauthorized`.

---

## MCP Endpoint

| Method | Path        | Auth required | Description                        |
|--------|-------------|---------------|------------------------------------|
| POST   | `/api/mcp`  | Yes           | Main MCP JSON-RPC endpoint         |
| GET    | `/api/mcp`  | Yes           | SSE streaming channel (optional)   |
| GET    | `/api/healthz` | No         | Health check (for uptime monitors) |

---

## Available Tools (33 Read + 32 Write)

**Read — 33 tools**
- Search, fetch, and list: `search_candidates`, `search_jobs`, `search_companies`, `search_contacts`, `get_candidate`, `get_job`, `get_company`, `get_contact`, `list_submissions_for_job`, `list_placements`, `get_notes`, `get_candidate_resume`, `list_candidate_attachments`, `read_candidate_attachment`, `count_entity`, `get_report`, `get_leaderboard`, `get_candidate_scorecard`, and 15 more.
- Reports: scorecards, leaderboards, open-job counts, confirmed-placement counts, and custom breakdowns.

**Write — 32 Bullhorn write tools** (per-user; each action runs as the recruiter's own Bullhorn identity)
- Candidate actions: `add_note`, `update_candidate`, `update_candidate_status`, `create_job_submission`, `bulk_create_submissions`, `update_submission_status`, `create_candidate_from_resume`
- Job & company: `create_job`, `update_job`, `create_company`, `update_company`, `create_contact`, `update_contact`
- Sales: `create_lead`, `update_lead`, `create_opportunity`, `update_opportunity`
- Workflow: `create_task`, `update_task`, `create_appointment`, `update_appointment`, `notify_users`, `create_tearsheet`, `add_candidates_to_tearsheet`, `remove_candidates_from_tearsheet`
- Placements & files: `create_placement`, `update_placement`, `create_sendout`, `upload_file_to_record`
- Destructive (soft-delete; `destructiveHint:true`, gated by the user's own Bullhorn delete rights): `delete_entity` (soft-deletes a Candidate, ClientContact, ClientCorporation, JobOrder, JobSubmission, Lead, or Opportunity — sets `isDeleted`, reversible, never a hard delete), `restore_entity` (un-deletes), `archive_placement` (cancels/archives a Placement via a status change — placements are billing-sensitive and are never soft-deleted). Generic `update_*` tools reject `isDeleted` so deletion only happens through these dedicated tools.

**Internal:** `create_support_ticket` (AskToAct support team)

### Lucene Query Examples

```
# Candidates in Chicago with .NET skills
primarySkills.name:".NET" AND address.city:"Chicago"

# Active candidates available in the next 30 days
status:Active AND dateAvailable:[NOW TO NOW+30DAY]

# Open job orders with .NET requirement
isOpen:true AND title:"Software Engineer"
```

---

## Environment Variables

Set all of these as secrets in Replit (never hardcode them):

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_BEARER_TOKEN` | **Yes** | Shared secret that ChatGPT Enterprise sends with every request |
| `BULLHORN_CLIENT_ID` | **Yes** | Bullhorn API client ID (from Bullhorn Support / partner portal) |
| `BULLHORN_CLIENT_SECRET` | **Yes** | Bullhorn API client secret |
| `BULLHORN_USERNAME` | **Yes** | Service account username for the password grant |
| `BULLHORN_PASSWORD` | **Yes** | Service account password |
| `RATE_LIMIT_MAX` | No | Max requests per window (default: 120) |
| `RATE_LIMIT_WINDOW_MS` | No | Rate limit window in milliseconds (default: 60000) |
| `PORT` | Yes | Port to listen on (set automatically by Replit) |

### Generating a secure bearer token

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and set it as `MCP_BEARER_TOKEN` in Replit Secrets.

### Rotating the bearer token

1. Generate a new token using the command above
2. Update `MCP_BEARER_TOKEN` in Replit Secrets
3. Restart the server
4. Update the token in your ChatGPT Enterprise app configuration (see below)
5. The old token is immediately invalid

---

## Registering in ChatGPT Enterprise

Follow these steps as a **ChatGPT Enterprise admin**:

### Step 1 — Find your server URL

Your deployed server URL will be:
```
https://<your-replit-app-name>.replit.app
```

The MCP endpoint is at:
```
https://<your-replit-app-name>.replit.app/api/mcp
```

### Step 2 — Create a new App/Connector

1. Log into [ChatGPT](https://chatgpt.com) as an admin (Business / Enterprise) or Plus user with Developer mode
2. Navigate to **Settings → Plugins** (some accounts label this **Apps** — same connector list)
3. Click **Create app** / **Create custom app** (wording varies)
4. Choose **MCP** / **Server URL** as the connection type

### Step 3 — Configure the app

| Field | Value |
|-------|-------|
| **Name** | `Bullhorn ATS` (or your preferred name) |
| **MCP server URL** | `https://<your-app>.replit.app/api/mcp` |
| **Authentication** | Bearer token |
| **Bearer token** | The value of your `MCP_BEARER_TOKEN` secret |

### Step 4 — Set access controls

1. Under **Access**, choose which users or groups can enable this app
2. Set write permissions to **Enabled** (the 32 write tools require per-user Bullhorn enrollment; each recruiter writes under their own Bullhorn identity)
3. Click **Save and publish**

### Step 5 — User enablement

Users can now:
1. Open a ChatGPT conversation
2. Click the **Plugins** icon (or **Apps**, or type `@` near the message box)
3. Toggle **Bullhorn ATS** / **AskToAct** on
4. Start asking questions like:
   - *"Find me candidates in Chicago with 5+ years of .NET experience"*
   - *"What are the open jobs at Acme Corp?"*
   - *"Show me recent notes on candidate #12345"*

---

## Recruiter enrollment (Bullhorn connect)

Invite links open `/api/auth/user/enroll?token=…` and show a **choice page**:

1. **Connect manually** (recommended) — username/password once on AskToAct; server completes OAuth headless. Avoids Bullhorn’s first-time “Agree → login loop” bounce.
2. **Continue with Bullhorn sign-in** — browser OAuth on Bullhorn. If consent bounces, re-open the link for recovery (manual first).

After connect, the page shows the personal MCP URL and ChatGPT setup steps. In ChatGPT Settings look for **Plugins** (some plans still say **Apps**) — same connector list.

---

## Running locally (development)

```bash
# Install dependencies
pnpm install

# Set environment variables (copy and fill in)
export MCP_BEARER_TOKEN=your-token-here
export BULLHORN_CLIENT_ID=your-client-id
export BULLHORN_CLIENT_SECRET=your-client-secret
export BULLHORN_USERNAME=your-username
export BULLHORN_PASSWORD=your-password
export PORT=5000

# Start the server
pnpm --filter @workspace/api-server run dev
```

Test the health endpoint:
```bash
curl http://localhost:5000/api/healthz
```

Test the MCP endpoint (should return 401 without token):
```bash
curl -X POST http://localhost:5000/api/mcp
# → {"error":"Missing or invalid Authorization header"}

curl -X POST http://localhost:5000/api/mcp \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Obtaining Bullhorn API Credentials

1. Contact **Bullhorn Support** or your Bullhorn account manager and request API access
2. They will provision a `client_id` and `client_secret` for your organization
3. Create a dedicated service account in Bullhorn to use for the API (do not use a personal user account)
4. The service account needs read/write access to: Candidates, JobOrders, ClientCorporations, ClientContacts, Notes, JobSubmissions, Placements, Tasks, Appointments, Tearsheets, and file attachments

---

## Available features

- **v1 — Read tools**: 33 search, fetch, report, and résumé-reading tools
- **v2 — Write tools (live)**: 32 write tools for notes, submissions, placements, jobs, companies, tasks, tearsheets, file uploads, and permission-aware soft-delete/restore/archive
- **v2 — Per-user OAuth (live)**: Each recruiter authenticates as their own Bullhorn user (not a shared service account), so every write is properly attributed

## Roadmap

- **v3 — Bulk outreach**: Search candidates → generate personalized messages via GPT → send via Bullhorn email
- **Multi-ATS**: Greenhouse, Lever, Vincere, Avionte connector library
