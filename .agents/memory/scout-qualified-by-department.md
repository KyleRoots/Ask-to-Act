# Scout Screen — qualified candidates by Internal Department

Support playbook for questions like: *“How many unique candidates have a Scout Screen - Qualified note for department STS-STSI (or MYT-Ottawa, etc.)?”*

## Bullhorn constraints (cannot fix in connector)

| Approach | Result on this instance |
|----------|-------------------------|
| `/search/Note` (Lucene) | **Always total 0** — even `id:<knownNoteId>` |
| `/query/Note` | **Rejected** — “Query operation not supported for Note” |
| `/entity/Candidate/{id}/notes` | **Works** |
| `/entity/Note/{id}` | **Works** |

See [bullhorn-note-lucene-empty.md](./bullhorn-note-lucene-empty.md) for Bullhorn Support ticket text.

## AskToAct entry points (Phase A)

| Surface | Name | When to use |
|---------|------|-------------|
| **MCP** | `scout_dept_report` | ChatGPT / Cursor — one call, department-parameterized |
| **REST** | `GET /v1/reports/scout-qualified-by-department?department=STS-STSI` | Custom GPT Actions, non-MCP clients |
| **Manual** | `get_notes` + job/submission tools | Debugging or when scout caps mark `incomplete: true` |

### MCP parameters (short names)

- `department` — **required** — Internal Department value on JobOrder (`correlatedCustomText1`), e.g. `STS-STSI`, `MYT-Ottawa`
- `noteAction` — default `Scout Screen - Qualified`
- `openJobsOnly` — default `true`
- `applicantPool` — default `responses` (New Lead / Online Applicant only; not recruiter submissions)
- `maxJobs` / `maxCandidatesToScan` — raise if result is `incomplete: true`
- `dateAddedStart` / `dateAddedEnd` — optional JobSubmission date window

### REST example

```http
GET /v1/reports/scout-qualified-by-department?department=MYT-Ottawa&maxJobs=50
Authorization: Bearer <MCP_BEARER_TOKEN or portal API key>
```

## What the workflow does

1. Find jobs where `correlatedCustomText1` = requested department (open by default).
2. Collect **Response-bucket** JobSubmissions (`New Lead`, `Online Applicant`) on those jobs — **not** Internally Submitted / Client Submission rows unless `applicantPool=all`.
3. For each unique candidate, `get_notes` via association.
4. Keep notes where `action` matches and the note references a scanned job via:
   - `jobOrder.id`, or
   - `Job ID: N` parsed from comments (ScoutGenius often leaves `jobOrder: null`).

## Validated example

- Candidate **4672021**, Note **7218418**, Job **35501** (Internal Department **MYT-Ottawa**)
- Note action: `Scout Screen - Qualified`
- `jobOrder: null` but comments contain `Job ID: 35501`

Check: `get_notes(4672021)` → `parsedJobOrderIds: [35501]`.

## ChatGPT MCP visibility

Production `tools/list` includes **69 tools** (~40k tokens of schema). ChatGPT may **truncate** long MCP inventories — if `scout_dept_report` is missing after reconnect:

1. Prefer **REST** Custom GPT Action for this report.
2. Or use manual workflow: department job count → `list_submissions_for_job` (response stage) → `get_notes` per candidate.
3. Phase B (deferred): MCP core/full tiers + CI token budget.

## Related memory

- [bullhorn-response-vs-submission.md](./bullhorn-response-vs-submission.md) — Response vs true submission
- [bullhorn-note-lucene-empty.md](./bullhorn-note-lucene-empty.md) — Lucene Note index ticket

## Deferred improvements

- **ScoutGenius write-side**: populate `jobOrder` on notes at creation (easier filtering; does **not** fix Lucene).
- **MCP description diet / tiers** — Phase B.
