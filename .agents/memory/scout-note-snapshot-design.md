---
name: Scout note snapshot design
description: Firm-scoped note snapshot when Bullhorn Note Lucene stays empty.
---

# Note action snapshot (implemented)

## Status

**Implemented (2026-08-03)** as a sustainable workaround while `/search/Note`
returns total 0. Phase 1 live early-exit remains the fallback when coverage is
missing or stale.

**v1.1 (2026-08-03):** sync indexes **all** open-job applicants (not only the
Response bucket), tags `response_applicant` on each note row, and serves
`applicantPool=all` from the snapshot when coverage is complete+fresh with
`applicant_pool_synced=all`. Default Responses requests filter
`response_applicant=true`.

## Goal

Make large-department and multi-department note-action reports finish under
the ChatGPT ~95s soft wall without depending on `/search/Note`.

## Scope (v1.1)

- All Internal Departments — no STSI hardcoding.
- Allowlisted `Note.action` values (default: prefix `Scout Screen -`).
- Sync: **open jobs** + **all** JobSubmission applicants; tag Response-bucket
  candidates via `response_applicant`.
- Same MCP/REST contract: `scout_dept_report` /
  `GET /v1/reports/scout-qualified-by-department`.

## Schema

- `note_action_snapshot` — PK `(firm_id, note_id)`; includes
  `response_applicant boolean`
- `note_snapshot_coverage` — PK `(firm_id, department)` with
  `status` (`complete` | `partial` | `failed`), `last_full_sync_at`, and
  `applicant_pool_synced` (`all` | `responses`)

## Allowlist / env

| Env | Meaning |
|-----|---------|
| `NOTE_SNAPSHOT_ACTION_PREFIXES` | Comma-separated prefixes. **Unset** → `Scout Screen -`. Empty string → no prefixes. |
| `NOTE_SNAPSHOT_ACTIONS` | Comma-separated exact actions (add recruiter actions later). |
| `NOTE_SNAPSHOT_TTL_MS` | Coverage freshness window (default **2 hours**). |

Do **not** dump a firm's full Note.action picklist into the default sync
allowlist — that explodes load. Firm picklists differ; expand via env only when
needed. Myticas reference picklist (expansion guidance only, not default sync):
Call-Connected, Call-Left VM, Call-No Answer, Call-Disconnected, Prescreen,
Left Message, Job Update, General Notes, Email, Intake Call,
Interview Prep/Debrief Notes, Offer/StartSheet/Placement, Meeting Notes,
Sales-Call-Connected, Sales-Call-Left VM, Sales-Call-No Answer,
Sales-Client Meeting/Teams, Client Meeting/Lunch, Sales Presentation/Proposal,
Linkedin Direct Message, Linkedin InMail, Other, Reference Check,
Skill Testing Results, Application, Automated Touchpoint, AI Vetter - Accept,
AI Vetter - Reject, New Hire, Background Check, Separation Details,
Sales Lead Provided, Candidate Referral Given, Important Notes,
Consultant Care - Check in, Consultant Care - Issue/Coaching,
Consultant Care - TERM, LinkedIn Note, LinkedIn InMail, Owner Reassignment.
("Scout Screen" is **not** on that UI picklist — ScoutGenius / separate product;
default prefix allowlist still covers `Scout Screen -*`.)

## Sync

`POST /api/firms/:id/note-snapshot/sync`  
Auth: `Authorization: Bearer $MCP_BEARER_TOKEN` (service only).  
Optional: `?department=STSI` or body `{ "department": "STSI" }`.

**Default response is HTTP 202 (async)** — the walk continues on the api-server
after the response so large departments are not killed by ~300s proxy timeouts.
Use `?wait=1` only for small single-dept debug syncs (returns the full summary).

Must run inside firm Bullhorn context (route sets `firmContext`).

### Railway Cron

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

1. If firm context + allowlisted action + open jobs + coverage `complete`
   within TTL:
   - `applicantPool=responses` (default) → snapshot rows with
     `response_applicant=true` + live tail (responses).
   - `applicantPool=all` → only when `applicant_pool_synced=all`; all snapshot
     rows + live tail (all applicants).
2. Else Lucene probe → association walk (existing Phase 1 path).

`autoWiden.noteScanPath` will be `snapshot+live_tail` when served from index.
`canConfirmTopNByJobRecency` stays **false** for `applicantPool=all` when
remaining jobs exist.

## Expanding beyond Scout

Add exact actions to `NOTE_SNAPSHOT_ACTIONS` (e.g. `Left Message,Submitted`)
and re-run sync — no schema change. Prefer a small allowlist over the full
firm picklist.

## Non-goals (still)

- Not a second MCP product.
- Do not infer actions from résumé text.
- Do not raise ChatGPT gateway soft walls.
- Async report jobs remain a later phase.
