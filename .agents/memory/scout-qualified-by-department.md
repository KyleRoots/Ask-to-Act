# Scout Screen — qualified candidates by Internal Department

Support playbook for questions like:

- *“How many unique candidates have a Scout Screen - Qualified note for department STS-STSI?”*
- *“List the five most recent STSI candidates with Scout Screen - Qualified”* (nicknames + top-N)

## Bullhorn constraints (cannot fix in connector)

| Approach | Result on this instance |
|----------|-------------------------|
| `/search/Note` (Lucene) | **Always total 0** — even `id:<knownNoteId>` |
| `/query/Note` | **Rejected** — “Query operation not supported for Note” |
| `/entity/Candidate/{id}/notes` | **Works** |
| `/entity/Note/{id}` | **Works** |

See [bullhorn-note-lucene-empty.md](./bullhorn-note-lucene-empty.md) for Bullhorn Support ticket text.

## AskToAct entry points

| Surface | Name | When to use |
|---------|------|-------------|
| **MCP** | `scout_dept_report` | ChatGPT / Cursor — one call, department-parameterized (fast; soft wall) |
| **MCP** | `start_scout_dept_report_job` + `get_report_job` | After sync `wall_time`, or when a confirmed-complete answer needs the ~20 min async budget |
| **REST** | `GET /api/v1/reports/scout-qualified-by-department?department=STSI&limit=5` | Custom GPT Actions, non-MCP clients |
| **REST** | `POST /api/v1/reports/scout-qualified-by-department/jobs` → `GET /api/v1/reports/jobs/:jobId` | Async same as MCP jobs |
| **Manual** | `get_notes` + job/submission tools | Debugging a known candidate |

### Natural-language contract (product non-negotiable)

**Keep it simple. Do not block accurate answers.**

- Users must **not** learn backend knobs (`maxJobs`, `mode`, Lucene, wall budgets). Those stay server-side.
- It **is** okay — and expected — for the AI to ask the user for **business clarification** when that improves accuracy.

### Universal soft-wall / blocker contract (all departments, all paths)

Soft walls are **channel realism** (ChatGPT ~120s). Sync `TOPN_WALL_MS` /
`EXHAUSTIVE_WALL_MS` stay put. The same continuation pattern applies to every
scout path that can return `wall_time` — live auto-widen, exhaustive, and
snapshot+live_tail — with the same `asyncContinuation` fields and wording.
No department-specific special cases.

| Sync outcome | Model action |
|--------------|--------------|
| `confirmedComplete: true` | Answer under those filters. |
| `stopReason=wall_time` (+ `asyncContinuation`) | Present partials if any; continue with the same args (or `resumeArgs`) via **MCP** (`start_scout_dept_report_job` → poll `get_report_job`) **or REST/Actions** (`asyncContinuation.rest`: `POST /reports/scout-qualified-by-department/jobs` → poll `GET /reports/jobs/{jobId}`, paths relative to `/api/v1`). **Never** date-window fan-out. **Never** give up because of the wall. |
| Other incomplete (caps) | Present lower bound; clarify or one broader/exhaustive call — not multi-window fan-out. |
| `no_matching_jobs` / confirmed zero | Safe to say none under those filters. |

The assistant should **keep working** until either:

1. `confirmedComplete: true`, or
2. an async job completes/fails after a sync `wall_time`, or
3. a true unworkable connector limit (e.g. `no_matching_jobs`), or
4. the user clarifies a different ask.

It must **not** stop solely because of an arbitrary search/page cap or the ChatGPT soft wall.

When parameters are clear enough, the model should:

1. Pass the spoken department or nickname (`STSI`, `Ottawa`, `STS-STSI`).
2. For “list / show **N** most recent”, pass **`limit=N`**.
3. Make **one** sync call. Then:
   - **`confirmedComplete: true`:** answer confidently under those filters.
   - **`wall_time` / `asyncContinuation`:** present partials; start async job (MCP tools **or** REST start+poll from `asyncContinuation.rest`); poll — never multi-call date-window fan-out.
   - **Other incomplete:** present the partial list; one broader/exhaustive follow-up is OK for totals — never date-window fan-out.
   - **`0` + `confirmedComplete: false`:** **do not conclude zero.** Clarify and/or continue via async / broader.
   - **`0` + `confirmedComplete: true`:** safe to say none matched under those filters.

Server behavior:

- Resolves nicknames via live Internal Department values (`STSI` → `STS-STSI`).
- Defaults to **open** jobs.
- Auto-pages jobs newest-first until exhausted, top-N job-recency early-exit
  proves `confirmedComplete`, or ~75s/95s gateway wall (safety valve).
- **Snapshot-first** when `note_snapshot_coverage` is complete and fresh (≤2h):
  rank from Postgres `note_action_snapshot` + live tail of newest open jobs.
  Default Responses filter `response_applicant=true`; `applicantPool=all` serves
  from snapshot only when `applicant_pool_synced=all`.
  See [scout-note-snapshot-design.md](./scout-note-snapshot-design.md).
- Scan strategy (live fallback): per newest job page — collect Response applicants
  (or all when `applicantPool=all`), then candidate-association `get_notes`
  (JobOrder.notes miss Scout Screen). Early-exit when remaining unscanned jobs
  are older than the Nth matching note (disabled for pool=all while jobs remain).
- Lucene-first path feature-detects `/search/Note`; falls back when total=0.
- For top-N / list asks: preload open jobs **newest-first** (`dateAdded` desc) and allow ~95s wall so July-level matches are not stranded behind older Lucene page order.
- Matches notes across the full association-loaded note set (not just a 50-row display page).
- Returns top-level `stopReason` + `confirmedComplete`.
- On sync `stopReason=wall_time` (any path: live walk, exhaustive, or
  snapshot+live_tail), response includes machine-readable `asyncContinuation`
  that is **host-complete**:
  - MCP: `tool=start_scout_dept_report_job`, `pollTool=get_report_job`
  - REST/Actions: `rest.start` = `POST /reports/scout-qualified-by-department/jobs`,
    `rest.poll` = `GET /reports/jobs/{jobId}` (relative to `/api/v1`)
  - optional `resumeArgs` + dual-host `hint`
  — **universal** soft-wall continuation, never date-window fan-out.
  See also [customgpt-actions-surface.md](./customgpt-actions-surface.md).
- When snapshot coverage is complete+fresh and the snapshot alone already holds
  a full top-N, live-tail soft wall alone does **not** demote
  `confirmedComplete` (universal correctness).
- Applicant note-scan budget prefers **newest JobSubmissions** (ordered query + eviction of older applicants when capped) so "most recent" asks stay accurate under the wall.

### Modes

| Mode | Behavior |
|------|----------|
| **`bounded`** (default) | Natural-language path (nickname resolve + optional `limit` + auto-widen). Prefer this for list/most-recent. |
| **`exhaustive`** | Submission-date lookback **counts** — ≤6 windows, default **30-day** lookback, soft **~75s wall**. Prefer explicit recent dates. Not the right default for “most recent N”. |

**Never** emulate exhaustive by calling `scout_dept_report` repeatedly with half-month / weekly / 3-day date windows.

### MCP parameters (AI-facing; keep off user chat)

- `department` — **required** — nickname or exact Internal Department (`correlatedCustomText1`)
- `limit` — for “N most recent” / “list N”
- `noteAction` — default `Scout Screen - Qualified`
- `openJobsOnly` — default `true`
- `applicantPool` — default `responses` (New Lead / Online Applicant)
- `mode` — leave default for list asks; `exhaustive` only for lookback counts
- `maxJobs` / `maxCandidatesToScan` / dates — optional; **do not ask the user**

### REST examples

Most recent (nickname):
```http
GET /api/v1/reports/scout-qualified-by-department?department=STSI&limit=5
Authorization: Bearer <MCP_BEARER_TOKEN or portal API key>
```

Count-style lower bound:
```http
GET /api/v1/reports/scout-qualified-by-department?department=MYT-Ottawa
```

Exhaustive lookback:
```http
GET /api/v1/reports/scout-qualified-by-department?department=MYT-Ottawa&mode=exhaustive
```

## What the workflow does

1. Resolve department nickname → exact `correlatedCustomText1` when needed.
2. Find jobs for that department (open by default); with `limit`, page through open jobs until filled / wall / exhausted.
3. Collect **Response-bucket** JobSubmissions (`New Lead`, `Online Applicant`) — not Internally Submitted / Client Submission unless `applicantPool=all`.
4. For each unique candidate, `get_notes` via association.
5. Keep notes where `action` matches and the note references a scanned job via `jobOrder.id` or `Job ID: N` in comments.
6. Rank by latest matching note date; apply `limit` when set.

## Validated example

- Candidate **4672021**, Note **7218418**, Job **35501** (Internal Department **MYT-Ottawa**)
- Note action: `Scout Screen - Qualified`
- `jobOrder: null` but comments contain `Job ID: 35501`

Check: `get_notes(4672021)` → `parsedJobOrderIds: [35501]`.

## ChatGPT MCP visibility

Production `tools/list` exposes the **full universal** tool set on one connector URL. See [mcp-universal-inventory.md](./mcp-universal-inventory.md).

If `scout_dept_report` is missing after reconnect:

1. Prefer **REST** Custom GPT Action for this report as a temporary workaround.
2. Or use manual workflow: department job count → `list_submissions_for_job` (response stage) → `get_notes` per candidate.
