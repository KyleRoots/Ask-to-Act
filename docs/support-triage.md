# Support email → GitHub → Local Agent workflow

This document describes how AskToAct routes customer support into engineering work.

## Why not paste emails into Cursor chat?

Copy-pasting each email into a one-off chat works for quick fixes, but you lose:

- A durable record tied to the reporter and firm
- Status (open / in progress / done)
- Linkage between the customer reply and the shipping PR
- A queue the team can prioritize without digging through chat history

GitHub Issues plus a local Cursor session gives you tracking **and** live investigation via MCP connectors.

## End-to-end flow

```
Customer email / Portal / MCP create_support_ticket
        ↓
   SUPPORT_EMAIL inbox  (SendGrid → SUPPORT_EMAIL env var)
        ↓
   Team triage (~2 min)  →  New GitHub issue (template below)
        ↓
   [Optional] needs-triage label while scoping
        ↓
   Local Cursor session on this repo (issue as context)
   ├── AskToAct MCP  → reproduce against live Bullhorn
   ├── Supabase MCP  → firm / user / token / auth_healthy state
   └── Railway MCP   → deploy status, logs, redeploy
        ↓
   Agent branches, implements, opens PR
        ↓
   Merge → auto-deploy → reply to customer at reporter email
```

## Shipping fixes (commit, push, docs)

Every correction or enhancement should land on GitHub and stay documented:

1. **Commit** with a clear message; **push** to `main` (or open a PR if the change is large).
2. **Update READMEs** in the same change when setup or behavior changes (`README.md`, `artifacts/*/README.md`, `AGENTS.md`, or this file).
3. **Verify deploy** on Railway after merge to `main` if the change affects production.

See `.cursor/rules/github-and-readme.mdc` and `AGENTS.md` (Shipping changes).

**Preferred runtime:** local Cursor with MCP connectors enabled. Cloud Agents remain an option when you need an isolated VM, but local sessions are faster for support because you can query production Bullhorn, Postgres, and Railway in one place without re-pasting context.

## Triage checklist (per email)

1. Open the message in your `SUPPORT_EMAIL` inbox.
2. In [GitHub Issues](https://github.com/KyleRoots/Ask-to-Act/issues/new/choose), pick the matching template:
   - **Bug report** — something broken
   - **Feature request** — enhancement idea
   - **Support question** — how-to / config (may not need code)
3. Paste the original email into the **Original email** field.
4. Fill reporter name, email, and firm when known.
5. Add labels (create once in repo Settings → Labels if missing):
   - `support` — any customer-originated item
   - `from-email` — came through the inbox (vs. filed directly on GitHub)
   - `needs-triage` — not ready for an agent yet
6. For bugs/features ready to build, remove `needs-triage` and open a local Cursor session on the issue.

## Working a ticket locally

From the GitHub issue (repo cloned, MCP connectors enabled):

1. Open the issue and start a **local Cursor Agent** session with the issue URL or number as context.
2. Use MCP to investigate before coding:
   - **AskToAct MCP** — reproduce Bullhorn tool calls (`describe_entity`, `search_candidates`, etc.)
   - **Supabase MCP** — check `firms`, `users`, `bullhorn_tokens.auth_healthy`, enrollment (`refresh_token`)
   - **Railway MCP** — confirm deploy status and pull logs for the api-server service
3. Branch from `main`, implement, open a PR.
4. Review, merge (auto-deploys via Railway), then email the reporter.

**Tip:** Put repro steps and expected behavior in the issue body. Agents do best with concrete failure modes, tool names, and Bullhorn entity context — not just "search is broken."

### Common support checks (Supabase)

```sql
-- Firm Bullhorn health
SELECT f.name, f.status, bt.auth_healthy, bt.last_auth_error, bt.updated_at
FROM firms f
LEFT JOIN bullhorn_tokens bt ON bt.firm_id = f.id
WHERE f.id = '<firm_id>';

-- Enrollment gap per firm
SELECT name, email, role,
       (refresh_token IS NOT NULL) AS enrolled,
       invited_at,
       (enroll_token IS NOT NULL AND enroll_token_expires_at > NOW()) AS invite_active
FROM users
WHERE firm_id = '<firm_id>'
ORDER BY enrolled DESC, name;
```

### Bullhorn reconnect (admin)

When `auth_healthy` is false or tokens are stale, use the admin reconnect wizard:

`/wizard?mode=reconnect&firmId=<firm_id>`

See `.agents/memory/` for operational gotchas (consent bounce, search syntax, custom fields, etc.).

## Cloud Agent (optional)

Use a **Cloud Agent** when you want an isolated VM (e.g. no local clone, or sharing work with someone who only has cloud access):

1. Open the issue you created.
2. Start a Cloud Agent with the issue as context (Cursor → Cloud Agents → reference the issue URL or number).
3. Set `ASKTOACT_MCP_API_KEY` in Cloud Agent Secrets for live Bullhorn access.
4. The agent works on a `cursor/<name>-0b63` branch and opens a PR against `main`.

## What stays out of GitHub

| Channel | Where it goes |
|---------|----------------|
| End-user portal form (`/support`) | `SUPPORT_EMAIL` → triage into GitHub |
| Connector setup help form | Same |
| MCP `create_support_ticket` from ChatGPT/Claude | Same |
| Direct email to `support@asktoact.ai` | Same |

GitHub is for **your team's work queue**, not a customer-facing ticket portal.

## Optional automation (later)

Manual triage is enough at low volume. When email volume grows, consider:

- **SendGrid Inbound Parse** → webhook → GitHub Issues API (auto-create draft issues)
- **Zapier / Make** — new email in inbox → GitHub issue with `needs-triage`
- **GitHub Action** — on `needs-triage` removal, post a comment template for agent handoff

None of this is required to start; issue templates plus the checklist above are sufficient.

## Suggested labels

| Label | Color | Purpose |
|-------|-------|---------|
| `support` | yellow | Customer-reported |
| `from-email` | light blue | Originated in SUPPORT_EMAIL |
| `needs-triage` | gray | Awaiting review before agent work |

Existing defaults (`bug`, `enhancement`, `question`) are applied automatically by the templates.
