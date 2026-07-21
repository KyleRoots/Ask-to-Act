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
- It **is** okay — and expected — for the AI to ask the user for **business clarification** when that improves accuracy (e.g. which department if ambiguous, open jobs vs all, “most recent 5” vs a full count, a rough time window). That is normal universal-agent behavior.
- Prefer: try a sensible default → return what you found → ask one clarifying question if the ask was ambiguous. Do not refuse or stall because a knob is missing.

When parameters are clear enough, the model should:

1. Pass the spoken department or nickname (`STSI`, `Ottawa`, `STS-STSI`).
2. For “list / show **N** most recent”, pass **`limit=N`**.
3. Make **one** call. Then:
   - **Results + `incomplete`:** present the partial list / lower bound — never fan out date windows. Ask a clarifying question only if the user needs a fuller answer.
   - **`0` + `incomplete`:** **do not conclude zero.** Say the first pass found none in the scanned portion, clarify (department / open vs closed / responses vs all), and/or call once more with broader business filters. Never date-window fan-out.
   - **`0` + complete scan:** then it is safe to say none matched under those filters.

Server behavior:

- Resolves nicknames via live Internal Department values (`STSI` → `STS-STSI`).
- Defaults to **open** jobs.
- With `limit`, auto-pages jobs in **one** call (~75s wall, up to ~2000 jobs), ranks by latest matching note `dateAdded`, returns top N.
- Without `limit` (count-style), stops after the first job page that finds matches (lower bound); if still empty, keeps paging until jobs/wall.

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
