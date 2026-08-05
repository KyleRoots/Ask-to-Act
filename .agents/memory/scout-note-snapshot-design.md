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

Service: `note-snapshot-cron` — image **`alpine:3.20`** (not `curlimages/curl`).
Schedule: **`*/30 * * * *`**. Does not restart the API.

**Why not `curlimages/curl`:** that image’s `ENTRYPOINT` is `curl`, so a Railway
`startCommand` of `sh -c '…'` becomes `curl sh -c '…'` and fails with
`curl: try 'curl --help'…`. Use alpine + busybox `wget` (or an image without a
curl entrypoint).

**startCommand shape (production):** Railway wraps the start command in a way
that does not expand `$VAR` unless an inner `sh -c "…"` runs. Hardcode the sync
URL (not secret); expand only `$MCP_BEARER_TOKEN` inside double quotes.

busybox `wget` exits non-zero on HTTP 4xx and prints `wget: server returned
error: …` to stderr. Capture headers with `2>/tmp/hdr`, use `wget … || true`,
then gate success with **fixed-string** `grep -F` for `HTTP/1.1|HTTP/2` +
`200|202|409`, print `SYNC_OK`, `exit 0`. Fragile `grep -E` / nested quoting
has failed under Railway before (deploy SUCCESS while cron execution still
CRASHED → crash email). Apply config via **deploy of current service config**,
not `redeploy` (redeploy replays the old manifest).

```bash
sh -c "wget -S -O /tmp/out \
  --header=\"Authorization: Bearer $MCP_BEARER_TOKEN\" \
  --header=\"Content-Type: application/json\" \
  --post-data=\"\" \
  https://connect.asktoact.ai/api/firms/<FIRM_ID>/note-snapshot/sync \
  >/tmp/out.body 2>/tmp/hdr || true; cat /tmp/hdr; \
  if grep -F 'HTTP/1.1 200' /tmp/hdr >/dev/null \
    || grep -F 'HTTP/1.1 202' /tmp/hdr >/dev/null \
    || grep -F 'HTTP/1.1 409' /tmp/hdr >/dev/null \
    || grep -F 'HTTP/2 200' /tmp/hdr >/dev/null \
    || grep -F 'HTTP/2 202' /tmp/hdr >/dev/null \
    || grep -F 'HTTP/2 409' /tmp/hdr >/dev/null; \
  then echo SYNC_OK; exit 0; fi; echo SYNC_FAIL; exit 1"
```

Expect **202 Accepted**. Concurrent duplicate syncs return **409** (already
in-flight). Treat **200 / 202 / 409** as cron success so a long firm walk does
not mark the Railway job CRASHED every half hour. Crash emails track **execution
exit code**, not merely deploy status.

Optional env `SYNC_URL` may exist for reference; production startCommand uses the
hardcoded URL above so expansion cannot fail.

Default snapshot TTL is **2 hours** (`NOTE_SNAPSHOT_TTL_MS`) — a 30‑minute cron
keeps coverage well inside that window.

**Transient Bullhorn HTTP:** association/`bullhornFetch` and Lucene search retry
**502/503/504** with bounded backoff (see `bullhorn-transient.ts`) so a single
gateway timeout does not mark a department `failed`.

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

## Async report jobs (implemented)

### Universal soft-wall → async pattern

Soft walls are **channel realism** for ChatGPT (~95s sync). They are **never**
raised on the sync MCP path and **never** a dead end. Shared builders live in
`async-job-contract.ts`; jobs reuse firm-scoped `report_jobs`. First tools beyond
Scout: `match_candidates_for_job` and `recruiter_leaderboard` — see
[universal-async-jobs.md](./universal-async-jobs.md).

For scout specifically:

1. Sync returns honest incomplete + `stopReason=wall_time` + machine-readable
   `asyncContinuation` (MCP `start_scout_dept_report_job` / `get_report_job`
   **and** REST `rest.start`/`rest.poll`; optional `resumeArgs`).
2. Model starts one async job with the same args; polls until complete/failed.
3. **Never** date-window fan-out. **Never** “give up because wall.”

| Surface | Name |
|---------|------|
| **MCP** | `start_scout_dept_report_job` → `get_report_job` |
| **REST** | `POST /api/v1/reports/scout-qualified-by-department/jobs` → `GET /api/v1/reports/jobs/:jobId` |

Schema: `report_jobs` (firm-scoped; status `queued|running|complete|failed`).
Runner reuses the same scout engine with `ASYNC_REPORT_WALL_MS` (~20 min safety
max only) + existing job/page caps; sync `TOPN_WALL_MS` / `EXHAUSTIVE_WALL_MS`
are unchanged.

**Top-N + fresh snapshot:** when coverage is complete+fresh and the snapshot
alone already holds a full top-N ranking, live-tail soft wall alone does not
force `confirmedComplete=false` (universal correctness, not a department hack).
