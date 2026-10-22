# Indeed publish checkbox — not queryable via Bullhorn REST

## User ask

“How many jobs are tagged with the Indeed checkbox?” (Publish Job screen → INDEED checkbox / Indeed Publication Status).

## Verdict

**Cannot answer reliably through the AskToAct connector today.** This is a Bullhorn REST limitation, not a missing MCP tool.

## Why

| UI concept | REST reality |
|------------|--------------|
| Indeed checkbox on Publish Job | Controls Indeed syndication feed inclusion — **not** a standard queryable JobOrder field |
| Indeed Publication Status (`Published` / `Not Published`) | Read-only UI field (BH R2026.2+) — **not** exposed on JobOrder meta for REST search/count |
| `JobOrder.jobBoardList` | Exists (`label: Job Board List`) but is a **manual** workaround field. Bullhorn’s own guidance: it is *not* auto-filled when you check Indeed; you must populate it yourself (e.g. value `Indeed`) to use it via API |

Live checks on this firm:

- Example job **35233** (Publish UI showed Indeed unchecked / Not Published): `jobBoardList: null`, `isPublic: 1`
- `count_entity` `jobBoardList:Indeed` → **0**
- Sample/`groupBy` on `jobBoardList` → no populated values

## Closest proxies (not Indeed)

These measure **career-portal / general publish**, not the Indeed checkbox:

| Query | Meaning | Approx. (live sample) |
|-------|---------|------------------------|
| `isPublic:1 AND isDeleted:false` | Publishing Status “public-ish” | ~626 |
| `dateLastPublished:[1 TO *] AND isDeleted:false` | Has been published at least once | ~173 |

Do **not** report these as “Indeed-tagged” counts.

## Firm-side workarounds (if they need API counts)

1. **Official Bullhorn workaround:** unhide `jobBoardList` on Job tracks; when a job is published to Indeed, set `jobBoardList` to include `Indeed` (manual, automation, or Bullhorn workflow). Then AskToAct can `count_entity` / `search_jobs` on `jobBoardList:Indeed`.
2. Custom boolean/text field + process to set it on publish/republish.
3. Ask Bullhorn Support whether Indeed Publication Status will ever be REST-exposed for their corp (today: no).

## AI guidance

If asked for Indeed checkbox / Indeed Publication Status counts:

1. Say the connector can read JobOrder fields, but Bullhorn does **not** expose the Indeed checkbox status via REST.
2. Do not invent a zero as “no jobs on Indeed.”
3. Offer proxies only if the user clarifies they mean “published to the career portal” (`isPublic` / `dateLastPublished`).
4. Offer the `jobBoardList` convention if they want a durable API-countable Indeed flag.

## References

- [How to fetch if a job is published by Indeed via REST API](https://help.bullhorn.com/article/How-to-fetch-if-a-job-is-published-by-Indeed-via-REST-API) — “It isn't directly possible” + `jobBoardList` workaround
- [Publishing Jobs to Indeed from Bullhorn](https://kb.bullhorn.com/ats/Content/BHATS/Topics/publishingJobsToIndeed.htm) — checkbox vs Publication Status UI behavior
