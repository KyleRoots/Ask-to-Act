---
name: Bullhorn auth automation (proactive refresh + reconnect email)
description: How AskToAct detects dead OAuth, refreshes proactively, and emails one-click reconnect links.
---

# Bullhorn auth automation

Silent OAuth refresh already runs on every stale session. This layer adds
**proactive refresh**, **automatic recruiter reconnect email**, and **ops-health
visibility** so Kyle is not the manual middleman when Josh’s connector expires.

## What is automatic

| Layer | Behavior |
|-------|----------|
| Firm + user access tokens | Silent refresh via `getSession` / `getUserSession` while refresh token is valid |
| Proactive cron | `bullhorn-auth-refresh-scheduler` (~60m, boot delay 3m) walks all firm tokens + users with `refresh_token` and calls those getters |
| User refresh death | `getUserSession` mints reconnect URL, then `maybeSendUserReconnectEmail` (24h cooldown) |
| Firm refresh death (oauth) | `markFirmAuthUnhealthy` + existing support email; ops-health → **critical** |
| Ops health | Unhealthy firms critical; users with `reconnect_email_sent_at` set and no refresh token → **warn** |

## What still needs a human

Bullhorn does not allow password-grant renewal for customer firms. When the
**refresh token** itself is dead, someone must open the reconnect link (recruiter)
or firm admin wizard (shared firm OAuth). Automation detects + notifies; it
cannot finish that step alone without storing Bullhorn passwords.

## Env

| Var | Default | Purpose |
|-----|---------|---------|
| `BULLHORN_AUTH_REFRESH` | on | `0` disables proactive scheduler |
| `BULLHORN_AUTH_REFRESH_INTERVAL_MS` | 3600000 (1h) | Tick interval (min 5m) |
| `BULLHORN_AUTH_REFRESH_USER_GAP_MS` | 250 | Pause between user refreshes |
| `RECONNECT_EMAIL_COOLDOWN_HOURS` | 24 | Skip duplicate auto reconnect emails |

## Code map

- `user-reconnect-notify.ts` — cooldown + SendGrid reconnect email
- `bullhorn-auth.ts` — `getUserSession` catch → auto email
- `bullhorn-auth-refresh.ts` / `bullhorn-auth-refresh-scheduler.ts` — proactive walk
- `ops-health.ts` — `evaluateBullhornAuthHealth`
- Schema: `users.reconnect_email_sent_at` (migration `0021`, also `ensureColumns`)

## Testing

- Unit: `user-reconnect-notify.test.ts`, `bullhorn-auth-refresh.test.ts`,
  `ops-health.test.ts` (auth issues)
- Live: wait for scheduler tick or call `runProactiveBullhornAuthRefresh` via a
  one-off; force a dead user refresh to confirm email + ops warn
