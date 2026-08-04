# Ops health alerts + agent email lifecycle

Know about durable-job / note-snapshot problems **before users report them**,
and get email when a Cursor agent **starts** and **finishes** working them.
Not a full observability platform — health check, email notify with dedupe,
agent start/complete emails, optional Cursor Automation.

## Email lifecycle (no Slack required)

| Step | When | Email subject |
|------|------|----------------|
| 1. Health detect | Scheduler / `?alert=1` finds warn\|critical | `[AskToAct ops WARN\|CRITICAL] …` |
| 2. Agent started | Automation/agent calls notify `phase=started` | `[AskToAct ops] Agent started` |
| 3. Agent completed | After fix/validate/deploy (or investigation ends) | `[AskToAct ops] Agent completed` (or `… failed`) |

All emails go to `OPS_ALERT_EMAIL` via SendGrid (`FROM_EMAIL`). If
`OPS_ALERT_EMAIL` is unset, notifies log and no-op (do not crash).

## Source of truth — health

`GET /api/internal/ops-health` (service bearer `MCP_BEARER_TOKEN` **or**
`OPS_HEALTH_SECRET`).

```bash
pnpm --filter @workspace/scripts ops-health
pnpm --filter @workspace/scripts ops-health -- --alert
pnpm --filter @workspace/scripts ops-health -- --json
```

Auth for scripts: `OPS_HEALTH_SECRET` or `ASKTOACT_MCP_API_KEY`.
Base URL: `ASKTOACT_MCP_BASE_URL` (default `https://connect.asktoact.ai`).

### Checks

1. **Note-snapshot coverage** — for active firms: failed/partial rows, or
   `last_full_sync_at` older than `NOTE_SNAPSHOT_TTL_MS` (warn) / 2× TTL
   (critical). Empty coverage → warn (cron may never have succeeded).
2. **report_jobs** — recent `failed` (esp. poison / max attempts), `queued`
   older than 10m/30m, `running` with expired lease or high `attempt_count`.

Response: `status` (`ok` | `warn` | `critical`) + `summary` + pasteable
`agentBrief` + `fingerprint` for dedupe.

## Notify loop (human) — health detect

api-server runs an in-process scheduler (~20m, `OPS_HEALTH_INTERVAL_MS`).
On warn/critical:

1. Always logs one structured line with `OPS_ALERT: true` (Railway logs).
2. If `OPS_ALERT_EMAIL` is set → SendGrid email with copy-paste Cursor block.
3. If `OPS_ALERT_WEBHOOK_URL` is set → POST JSON payload (optional bridge).
4. Dedupe via `ops_alert_state` (fingerprint + `OPS_ALERT_COOLDOWN_MINUTES`,
   default 180). Same issue set won't re-email every tick.

Disable everything: `OPS_ALERTS=0`.

`?alert=1` on the HTTP route also runs maybe-notify (for external cron if needed).

## Agent start / complete notify

Authenticated path the Cursor Automation (or any agent) calls when it picks up
or finishes an ops problem.

### HTTP

```bash
curl -sS -X POST "https://connect.asktoact.ai/api/internal/ops-agent-notify" \
  -H "Authorization: Bearer $ASKTOACT_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phase":"started","summary":"Investigating stale note-snapshot","fingerprint":"note-stale"}'

curl -sS -X POST "https://connect.asktoact.ai/api/internal/ops-agent-notify" \
  -H "Authorization: Bearer $ASKTOACT_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phase":"completed","summary":"Fixed + verified ops-health ok","details":"Redeployed api-server; note sync current","fingerprint":"note-stale"}'
```

Body: `phase` (`started` | `completed` | `failed`), `summary` (required, ≤500),
optional `details` (≤4000), optional `fingerprint` (dedupe key for `started`).

Auth: same as ops-health (`MCP_BEARER_TOKEN` or `OPS_HEALTH_SECRET`).

### CLI

```bash
pnpm --filter @workspace/scripts ops-agent-notify -- \
  --phase started --summary "Investigating report_jobs stuck" --fingerprint jobs-stuck

pnpm --filter @workspace/scripts ops-agent-notify -- \
  --phase completed --summary "Lease reclaim fixed; ops-health ok" \
  --details "Validated after deploy" --fingerprint jobs-stuck

pnpm --filter @workspace/scripts ops-agent-notify -- \
  --phase failed --summary "Could not reproduce; logged only"
```

Duplicate `started` for the same fingerprint within
`OPS_AGENT_NOTIFY_DEDUPE_MINUTES` (default 15) is skipped so retries don't spam.

## Cursor Automation — paste these instructions

Update the **existing** Active ops automation instructions to (parent cannot
patch Automations via API — paste manually in the Automations editor):

```
You are the AskToAct ops health responder. You have no Slack — communicate only via email notify + your final reply.

1. Run: pnpm --filter @workspace/scripts ops-health -- --json
   Auth: ASKTOACT_MCP_API_KEY or OPS_HEALTH_SECRET (Cursor Secrets). Base: ASKTOACT_MCP_BASE_URL (default https://connect.asktoact.ai).

2. If status is ok: stop. Do not send notify emails.

3. If status is warn or critical:
   a. FIRST send a started email:
      pnpm --filter @workspace/scripts ops-agent-notify -- --phase started --summary "<one-line brief from health summary>" --fingerprint "<health fingerprint from JSON>"
   b. Investigate and fix using the printed agentBrief / issues. Prefer smallest coherent change. Soft walls / async jobs: see repo docs on universal-async-jobs and ops-alerts. Do NOT raise soft walls.
   c. Validate (re-run ops-health, and deploy if you changed api-server). Do not claim success without evidence.
   d. BEFORE finishing, send a completed (or failed) email:
      pnpm --filter @workspace/scripts ops-agent-notify -- --phase completed --summary "<what was done>" --details "<validated/deployed evidence>" --fingerprint "<same fingerprint>"
      Or --phase failed if you could not fix / reproduce.
   e. Summarize outcome in your final reply (what changed, checks run, deploy status).

Never put secrets in git. Leave unrelated dirty files alone.
```

## Env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `OPS_ALERT_EMAIL` | to enable email | Destination for health + agent notify emails |
| `OPS_ALERT_WEBHOOK_URL` | optional | HTTP POST bridge (health alerts only) |
| `OPS_ALERT_COOLDOWN_MINUTES` | optional (180) | Health-alert dedupe window |
| `OPS_AGENT_NOTIFY_DEDUPE_MINUTES` | optional (15) | Skip duplicate `started` notifies |
| `OPS_HEALTH_INTERVAL_MS` | optional (20m) | In-process health tick |
| `OPS_ALERTS` | optional | `0` disables health scheduler + health notify |
| `OPS_HEALTH_SECRET` | optional | Dedicated bearer (else MCP token) |
| `SENDGRID_API_KEY` / `FROM_EMAIL` | for email | Existing transactional mail |

## Code map

- Evaluate: `artifacts/api-server/src/lib/ops-health.ts`
- Health notify/dedupe: `artifacts/api-server/src/lib/ops-alerts.ts`
- Agent notify: `artifacts/api-server/src/lib/ops-agent-notify.ts`
- Scheduler: `artifacts/api-server/src/lib/ops-health-scheduler.ts`
- Routes: `artifacts/api-server/src/routes/ops-health.ts`, `ops-agent-notify.ts`
- Auth: `artifacts/api-server/src/middlewares/ops-internal-auth.ts`
- Table: `ops_alert_state` (migration `0017_ops_alert_state`)
- Scripts: `scripts/src/ops-health.ts`, `scripts/src/ops-agent-notify.ts`
