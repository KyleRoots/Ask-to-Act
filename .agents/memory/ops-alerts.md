# Ops health alerts (light early-warning)

Know about durable-job / note-snapshot problems **before users report them**.
Not a full observability platform — one health check, email/webhook notify with
dedupe, optional Cursor Automation.

## Source of truth

`GET /api/internal/ops-health` (service bearer `MCP_BEARER_TOKEN` **or**
`OPS_HEALTH_SECRET`).

Also:

```bash
pnpm --filter @workspace/scripts ops-health
pnpm --filter @workspace/scripts ops-health -- --alert
pnpm --filter @workspace/scripts ops-health -- --json
```

Auth for the script: `OPS_HEALTH_SECRET` or `ASKTOACT_MCP_API_KEY`.
Base URL: `ASKTOACT_MCP_BASE_URL` (default `https://connect.asktoact.ai`).

### Checks

1. **Note-snapshot coverage** — for active firms: failed/partial rows, or
   `last_full_sync_at` older than `NOTE_SNAPSHOT_TTL_MS` (warn) / 2× TTL
   (critical). Empty coverage → warn (cron may never have succeeded).
2. **report_jobs** — recent `failed` (esp. poison / max attempts), `queued`
   older than 10m/30m, `running` with expired lease or high `attempt_count`.

Response: `status` (`ok` | `warn` | `critical`) + `summary` + pasteable
`agentBrief` + `fingerprint` for dedupe.

## Notify loop (human)

api-server runs an in-process scheduler (~20m, `OPS_HEALTH_INTERVAL_MS`).
On warn/critical:

1. Always logs one structured line with `OPS_ALERT: true` (Railway logs).
2. If `OPS_ALERT_EMAIL` is set → SendGrid email with copy-paste Cursor block.
3. If `OPS_ALERT_WEBHOOK_URL` is set → POST JSON payload (Slack/email bridge).
4. Dedupe via `ops_alert_state` (fingerprint + `OPS_ALERT_COOLDOWN_MINUTES`,
   default 180). Same issue set won't re-email every tick.

Disable everything: `OPS_ALERTS=0`.

`?alert=1` on the HTTP route also runs maybe-notify (for external cron if needed).

## Agent loop (best effort)

1. **Paste path:** open the alert email → copy the `agentBrief` block → paste
   into Cursor.
2. **Scheduled Cursor Automation:** every hour, run
   `pnpm --filter @workspace/scripts ops-health` (secret
   `ASKTOACT_MCP_API_KEY` or `OPS_HEALTH_SECRET`). If exit ≠ 0, investigate
   using the printed agent brief. Soft walls / async jobs docs:
   [universal-async-jobs](universal-async-jobs.md).

## Env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `OPS_ALERT_EMAIL` | to enable email | Destination for ops alerts |
| `OPS_ALERT_WEBHOOK_URL` | optional | HTTP POST bridge |
| `OPS_ALERT_COOLDOWN_MINUTES` | optional (180) | Dedupe window |
| `OPS_HEALTH_INTERVAL_MS` | optional (20m) | In-process tick |
| `OPS_ALERTS` | optional | `0` disables scheduler + notify |
| `OPS_HEALTH_SECRET` | optional | Dedicated bearer (else MCP token) |
| `SENDGRID_API_KEY` / `FROM_EMAIL` | for email | Existing transactional mail |

## Code map

- Evaluate: `artifacts/api-server/src/lib/ops-health.ts`
- Notify/dedupe: `artifacts/api-server/src/lib/ops-alerts.ts`
- Scheduler: `artifacts/api-server/src/lib/ops-health-scheduler.ts`
- Route: `artifacts/api-server/src/routes/ops-health.ts`
- Table: `ops_alert_state` (migration `0017_ops_alert_state`)
