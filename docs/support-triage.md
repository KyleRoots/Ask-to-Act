# Support email → GitHub → Cloud Agent workflow

This document describes how AskToAct routes customer support into engineering work.

## Why not paste emails into Cursor chat?

Copy-pasting each email into a Cloud Agent chat works for one-off fixes, but you lose:

- A durable record tied to the reporter and firm
- Status (open / in progress / done)
- Linkage between the customer reply and the shipping PR
- A queue the team can prioritize without digging through chat history

GitHub Issues plus Cursor Cloud Agents gives you tracking **and** automated implementation.

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
   Launch Cursor Cloud Agent on the issue
        ↓
   Agent branches, implements, opens PR
        ↓
   Merge → reply to customer at reporter email
```

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
6. For bugs/features ready to build, check **Ready for Cloud Agent?** and remove `needs-triage`.

## Launching a Cloud Agent

From the GitHub issue (or from Cursor linked to the repo):

1. Open the issue you just created.
2. Start a **Cloud Agent** with the issue as context (Cursor → Cloud Agents → reference the issue URL or number).
3. The agent works on a `cursor/<name>-0b63` branch and opens a PR against `main`.
4. Review the PR, merge, deploy, then email the reporter with the resolution.

**Tip:** Put repro steps and expected behavior in the issue body. Agents do best with concrete failure modes, tool names, and Bullhorn entity context — not just "search is broken."

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
