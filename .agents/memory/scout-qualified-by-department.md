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
| **MCP** | `scout_dept_report` | ChatGPT / Cursor — one call, department-parameterized |
| **REST** | `GET /api/v1/reports/scout-qualified-by-department?department=STSI&limit=5` | Custom GPT Actions, non-MCP clients |
| **Manual** | `get_notes` + job/submission tools | Debugging a known candidate |

### Natural-language contract (product non-negotiable)

**Keep it simple. Do not block accurate answers.**

- Users must **not** learn backend knobs (`maxJobs`, `mode`, Lucene, wall budgets). Those stay server-side.
- It **is** okay — and expected — for the AI to ask the user for **business clarification** when that improves accuracy.
- The assistant should **keep working** until either:
  1. `confirmedComplete: true` (scan finished under the chosen filters), or
  2. `stopReason` is a **real** connector/platform limit it cannot work around (`wall_time`, `no_matching_jobs`, Bullhorn Note Lucene unavailable), or
  3. the user clarifies a different ask.
- It must **not** stop solely because of an arbitrary search/page cap. Caps are server-side pacing; incomplete results mean “continue / clarify / one broader call,” not “give up.”

When parameters are clear enough, the model should:

1. Pass the spoken department or nickname (`STSI`, `Ottawa`, `STS-STSI`).
2. For “list / show **N** most recent”, pass **`limit=N`**.
3. Make **one** call. Then:
   - **`confirmedComplete: true`:** answer confidently under those filters.
   - **Results + `incomplete`:** present the partial list; check `stopReason`. One follow-up with `mode=exhaustive` or broader filters is OK for totals — never multi-call date-window fan-out.
   - **`0` + `confirmedComplete: false`:** **do not conclude zero.** Clarify and/or retry once broader.
   - **`0` + `confirmedComplete: true`:** safe to say none matched under those filters.

Server behavior:

- Resolves nicknames via live Internal Department values (`STSI` → `STS-STSI`).
- Defaults to **open** jobs.
- Auto-pages jobs until exhausted or ~75s gateway wall (safety valve, not a “give up” signal for the model when results are incomplete).
- For top-N / list asks: preload open jobs **newest-first** (`dateAdded` desc) and allow ~95s wall so July-level matches are not stranded behind older Lucene page order.
- Matches notes across the full association-loaded note set (not just a 50-row display page).
- Returns top-level `stopReason` + `confirmedComplete`.
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
