---
name: Scout note snapshot design
description: Firm-scoped note snapshot when Bullhorn Note Lucene stays empty.
---

# Note action snapshot (implemented)

## Status

**Implemented (2026-08-03)** as a sustainable workaround while `/search/Note`
returns total 0. Phase 1 live early-exit remains the fallback when coverage is
missing or stale.

## Goal

Make large-department and multi-department note-action reports finish under
the ChatGPT ~95s soft wall without depending on `/search/Note`.

## Scope (v1)

- All Internal Departments — no STSI hardcoding.
- Allowlisted `Note.action` values (default: prefix `Scout Screen -`).
- Sync: **open jobs** + **Response** applicants only.
- Same MCP/REST contract: `scout_dept_report` /
  `GET /v1/reports/scout-qualified-by-department`.

## Schema

- `note_action_snapshot` — PK `(firm_id, note_id)`
- `note_snapshot_coverage` — PK `(firm_id, department)` with
  `status` (`complete` | `partial` | `failed`) and `last_full_sync_at`

## Allowlist / env

| Env | Meaning |
|-----|---------|
| `NOTE_SNAPSHOT_ACTION_PREFIXES` | Comma-separated prefixes. **Unset** → `Scout Screen -`. Empty string → no prefixes. |
| `NOTE_SNAPSHOT_ACTIONS` | Comma-separated exact actions (add recruiter actions later). |
| `NOTE_SNAPSHOT_TTL_MS` | Coverage freshness window (default **2 hours**). |

## Sync

`POST /api/firms/:id/note-snapshot/sync`  
Auth: `Authorization: Bearer $MCP_BEARER_TOKEN` (service only).  
Optional: `?department=STSI` or body `{ "department": "STSI" }`.

**Default response is HTTP 202 (async)** — the walk continues on the api-server
after the response so large departments are not killed by ~300s proxy timeouts.
Use `?wait=1` only for small single-dept debug syncs (returns the full summary).

Must run inside firm Bullhorn context (route sets `firmContext`).

### Railway Cron (hourly)

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  "https://connect.asktoact.ai/api/firms/<FIRM_ID>/note-snapshot/sync"
```

Expect **202 Accepted**. Point Railway Cron at that URL every **30 minutes**
(`*/30 * * * *`). Service: `note-snapshot-cron` (curl image; does not restart
the API). Concurrent duplicate syncs for the same firm/department return **409**.

Default snapshot TTL is **2 hours** (`NOTE_SNAPSHOT_TTL_MS`) — a 30‑minute cron
keeps coverage well inside that window.

## Read path

`scoutQualifiedByDepartment`:

1. If firm context + allowlisted action + open/responses + coverage
   `complete` within TTL → serve from snapshot + **live tail** (newest ~20 jobs).
2. Else Lucene probe → association walk (existing Phase 1 path).

`autoWiden.noteScanPath` will be `snapshot+live_tail` when served from index.

## Expanding beyond Scout

Add exact actions to `NOTE_SNAPSHOT_ACTIONS` (e.g. `Left Message,Submitted`)
and re-run sync — no schema change.

## Non-goals (still)

- Not a second MCP product.
- Do not infer actions from résumé text.
- Do not raise ChatGPT gateway soft walls.
