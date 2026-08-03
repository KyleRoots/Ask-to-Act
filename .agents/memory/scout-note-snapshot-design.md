---
name: Scout note snapshot design
description: Phase-3 design for a department-agnostic note snapshot if Bullhorn Note Lucene stays empty.
---

# Scout note snapshot (Phase 3 — only if Lucene stays broken)

## Status

As of 2026-08-03, Lucene `/search/Note` still returns `total: 0` on Myticas
(rest45). Phase 1 (top-N early-exit + collect-then-notes) and Phase 2
(Lucene-first with association fallback) shipped in the connector. **Do not
build this snapshot until Bullhorn Support confirms Lucene will not be
restored on a usable timeline.**

## Goal

Make large-department and multi-department note-action reports finish under
the ChatGPT ~95s soft wall without depending on `/search/Note`.

## Scope

- All Internal Departments (`JobOrder.correlatedCustomText1`) — no STSI hardcoding.
- Configured note actions first (default: Scout Screen action family).
- Same MCP/REST contract: `scout_dept_report` /
  `GET /v1/reports/scout-qualified-by-department`.

## Proposed schema (Postgres)

```sql
CREATE TABLE scout_note_snapshot (
  note_id           bigint PRIMARY KEY,
  action            text NOT NULL,
  candidate_id      bigint NOT NULL,
  job_id            bigint,              -- null when only in comments; prefer parsed
  department        text,                -- denormalized correlatedCustomText1
  note_date_added   bigint NOT NULL,     -- Bullhorn epoch ms
  candidate_first   text,
  candidate_last    text,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scout_note_snapshot_dept_action_date
  ON scout_note_snapshot (department, action, note_date_added DESC);

CREATE INDEX scout_note_snapshot_synced
  ON scout_note_snapshot (synced_at);
```

## Sync strategy

1. **Nightly / hourly Railway cron** (outside ChatGPT turn): for each known
   department value, walk open jobs → Response applicants → `get_notes`
   (candidate association), upsert rows matching configured actions.
2. **Freshness**: `scout_dept_report` serves from snapshot when
   `synced_at` is within a configured TTL (e.g. 2h). Optionally live-refresh
   the newest N jobs' applicants for the department to catch notes since sync.
3. **Idempotent**: upsert on `note_id`; delete snapshot rows whose jobs left
   the open set only if the report defaults to openJobsOnly (keep historical
   rows when `openJobsOnly=false`).

## Read path

- Rank/limit/count from snapshot filtered by `department` + `action` (+
  optional date bounds).
- Set `confirmedComplete` from snapshot coverage metadata (last full dept
  walk finished, no wall abort).
- If snapshot missing/stale for a department, fall back to today's live
  association walk (Phase 1).

## Non-goals

- Not a second MCP product or UI dashboard.
- Do not infer actions from résumé text.
- Do not raise ChatGPT gateway soft walls.
