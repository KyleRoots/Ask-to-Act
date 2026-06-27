# Bullhorn ATS MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server that connects **ChatGPT Enterprise** to **Bullhorn ATS**. When a user enables the Bullhorn app in ChatGPT, they can search and retrieve live Bullhorn data through natural language — without ever leaving ChatGPT.

This is pure middleware. No UI, no user login screens. ChatGPT calls this server silently in the background.

---

## Architecture

```
ChatGPT Enterprise  ──►  This MCP Server  ──►  Bullhorn REST API
   (user toggle)         (hosted on Replit)      (your ATS data)
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

## Available Tools (Read-Only, v1)

| Tool | Description |
|------|-------------|
| `search_candidates` | Full-text search across candidates using Lucene queries |
| `search_jobs` | Search job orders by status, title, client, and more |
| `search_companies` | Search client company (ClientCorporation) records |
| `search_contacts` | Search client contact records |
| `get_candidate` | Fetch a full candidate record by Bullhorn ID |
| `get_job` | Fetch a full job order record by Bullhorn ID |
| `get_company` | Fetch a full client company record by Bullhorn ID |
| `get_contact` | Fetch a full client contact record by Bullhorn ID |
| `list_submissions_for_job` | List all candidate submissions for a job order |
| `list_placements` | List placements, filtered by candidate or job ID |
| `get_notes` | Retrieve notes/activity log for a candidate or job |

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

1. Log into [ChatGPT Enterprise admin portal](https://chatgpt.com) as an admin
2. Navigate to **Settings → Apps** (previously called "Connectors")
3. Click **Create custom app**
4. Choose **MCP** as the app type

### Step 3 — Configure the app

| Field | Value |
|-------|-------|
| **Name** | `Bullhorn ATS` (or your preferred name) |
| **MCP server URL** | `https://<your-app>.replit.app/api/mcp` |
| **Authentication** | Bearer token |
| **Bearer token** | The value of your `MCP_BEARER_TOKEN` secret |

### Step 4 — Set access controls

1. Under **Access**, choose which users or groups can enable this app
2. Set write permissions to **Disabled** (this is read-only; write tools are v2)
3. Click **Save and publish**

### Step 5 — User enablement

Users can now:
1. Open a ChatGPT conversation
2. Click the **Apps** icon (or "+" near the message box)
3. Toggle **Bullhorn ATS** on
4. Start asking questions like:
   - *"Find me candidates in Chicago with 5+ years of .NET experience"*
   - *"What are the open jobs at Acme Corp?"*
   - *"Show me recent notes on candidate #12345"*

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
4. The service account needs read access to: Candidates, JobOrders, ClientCorporations, ClientContacts, Notes, JobSubmissions, Placements

---

## Deploying to Railway + Supabase

The repo ships a portable `Dockerfile` (at the repo root) and a `railway.json`, so
the server can run on Railway, Render, Fly.io, or any container host. The
reference setup is **Railway** (runs the server) + **Supabase** (Postgres).

### 1. Database (Supabase)

1. Create a free Supabase project and copy its Postgres connection string
   (Project Settings → Database → Connection string → URI).
2. Create the one table the server needs. Either run the schema push locally
   with `DATABASE_URL` pointed at Supabase:

   ```bash
   DATABASE_URL="postgresql://...supabase..." pnpm --filter @workspace/db run push
   ```

   …or create it directly with SQL:

   ```sql
   create table if not exists bullhorn_tokens (
     id text primary key,
     refresh_token text not null,
     updated_at timestamp not null default now()
   );
   ```

### 2. Server (Railway)

1. Create a Railway project from this GitHub repo. Railway reads `railway.json`
   and builds the root `Dockerfile` automatically.
2. Set the environment variables (see the table above). At minimum:
   `MCP_BEARER_TOKEN`, `DATABASE_URL` (the Supabase URI), `BULLHORN_CLIENT_ID`,
   `BULLHORN_CLIENT_SECRET`, `BULLHORN_USERNAME`, `BULLHORN_PASSWORD`, and
   `BULLHORN_REDIRECT_URI`. `PORT` is provided by Railway.
3. Deploy. Railway health-checks `/api/healthz`.

### 3. Connect Bullhorn (one-time)

After the first deploy the token table is empty, so trigger the one-time
Bullhorn connection (headless, no browser):

```bash
curl -X POST https://<your-app>.up.railway.app/api/auth/bullhorn/connect \
  -H "Authorization: Bearer <MCP_BEARER_TOKEN>"
```

### 4. Point ChatGPT at the new URL

Update the MCP server URL in the ChatGPT Enterprise connector to
`https://<your-app>.up.railway.app/api/mcp` (keep the same bearer token to avoid
any per-user reconfiguration). A custom domain in front keeps this URL stable
across future moves.

## Roadmap

- **v2 — Write tools**: Add note, update candidate status, update job fields, change placement status (with ChatGPT confirmation prompts)
- **v2 — Per-user OAuth**: Each ChatGPT user authenticates as themselves in Bullhorn (proper audit trail)
- **v3 — Bulk outreach**: Search candidates → generate personalized messages via GPT → send via Bullhorn email
- **Multi-ATS**: Greenhouse, Lever, Vincere, Avionte connector library
