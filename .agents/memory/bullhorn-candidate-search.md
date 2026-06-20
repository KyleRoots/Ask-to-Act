---
name: Bullhorn candidate skill/experience search landscape & résumé PII policy
description: Which candidate fields are actually searchable for skills/experience (and their relative completeness), the query rules Bullhorn enforces, and how raw résumé text (description) is redacted across read paths.
---

# Candidate skill & experience search (corp 28404 / swimlane 45)

A candidate's skills live in THREE Lucene-searchable fields, very different in completeness:
- `skillSet` — free-text skills list, the **most populated** structured-ish source.
- `primarySkills.name` — truly structured skills, but **often sparse/empty**.
- `description` — the **parsed résumé text**, fully Lucene-searchable and by far the **richest**.

Live magnitude check (hit counts, illustrative not exact): `description:Kubernetes` ≫ `skillSet:Kubernetes` ≫ `primarySkills.name:*`. The résumé text catches skills, tools, and certifications that never made it into the structured fields.

**How to apply:** for recall, search skills as `(skillSet:X OR description:X)` and AND the must-haves together; don't rely on `primarySkills.name` alone (you'll miss most people).

## Query rules Bullhorn enforces here
- **Bare, unfielded keywords are REJECTED with HTTP 400** — every term must be field-qualified.
- **Quoted multi-word terms are NOT strict exact-phrase** — matching is relevance-ranked, so quoting just groups the words; verify the top hits.
- **Years-of-experience is NOT a usable query filter** — the structured `experience` field is unreliable/empty. Infer tenure/recency from `workHistories` `startDate`/`endDate` (epoch ms) and the résumé text instead, by reading the shortlist (get_candidate + get_candidate_resume).

## Résumé-text (description) PII policy — read chokepoint redaction
`candidate.description` is parsed résumé text and can contain SSNs. Policy in this codebase:
- It is **SSN-redacted centrally** at the three read chokepoints (`searchEntity`/`queryEntity`/`getEntity`). The redactor masks BOTH (a) a top-level Candidate record's own `description`, AND (b) résumé text nested as a `candidate`/`candidates` association on ANY entity (e.g. `JobSubmission.candidate(id,description)`) via a depth-bounded recursive scan. So a candidate's résumé is masked no matter which entity/field path requests it. **Pitfall:** an early `entity === "Candidate"` gate is NOT enough — nested `candidate(description)` on a non-Candidate read silently bypasses it (verified live). Other entities' own `description` (job/company/note text) is intentionally left untouched.
- It is **not in `get_candidate` default fields** — full résumé text is served only by `get_candidate_resume`, which redacts SSNs and length-caps.
- `get_candidate_resume` uses a **separate bullhornFetch path** (not the three chokepoints) and redacts itself, so there is no double-processing.

**Why:** steering the AI to weigh résumé CONTENT (not just structured skill fields) amplifies exposure of raw résumé PII; redacting at the chokepoint keeps every path safe regardless of which fields a caller requests.
**How to apply:** never reintroduce `description` into a candidate default field list, and keep any new candidate read path flowing through the three chokepoints (or redact explicitly) so the SSN guarantee holds.

## List/search payload size — "blocked by the tool-safety layer"
Returning full résumé `description` for many candidates makes the response huge: a `count=100` candidate search with `description` in `fields` is **~2.5 MB** (median résumé ~22 k chars, max ~65 k). MCP clients (ChatGPT) silently DROP oversized tool results and narrate it as **"blocked by the tool-safety layer"** — our server returns **200 OK every time**, so the block is CLIENT-side, not ours. Symptom: very long agent runtime, repeated re-tries with smaller scope, then "could not retrieve / no records."
- Fix: `redactCandidateDescriptions(entity, json, { capDescription })` truncates each résumé `description` to a short preview (~600 chars + a "call get_candidate_resume" marker) ONLY on the LIST paths (`searchEntity`/`queryEntity`, incl. nested candidate associations). Single-record `getEntity`/`get_candidate` stays UNCAPPED; `get_candidate_resume` (separate file-based path) stays full. Same broad search dropped **2.47 MB → ~0.13 MB**.
- Tool guidance now tells the AI: search résumé text via the QUERY (`description:Kubernetes`) but do NOT put `description` in returned `fields`; read a full résumé via `get_candidate_resume` (param is `candidateId`, NOT `id`) on the ~5-candidate shortlist.
**Why:** the résumé-content steering tempts the model to request `description` for large result sets, which silently breaks the whole call. Redaction runs BEFORE truncation, so the preview can never leak a raw SSN.

## Candidate "status" — "active" does NOT mean `status:Active`
The candidate `status` field in this Myticas instance is dominated by **'Online Applicant'** and **'New Lead'** (the workable pool); **'Active'** is a minority (~14% in an ID-range census across the live ID space) and **'Archive'** is the main inactive bucket observed (other inactive statuses like Placed/Do-Not-Contact may exist). So a literal `status:Active` filter silently drops most workable people, and ChatGPT burned minutes reasoning its way around it. For "available/contactable/submit-ready" (stronger than "active"), don't assume non-archived == actionable — verify via placements/submissions/notes on the shortlist.
- Express "active / current / workable candidates" as **`AND NOT status:Archive`** (also `-status:Archive` works) — keeps the full workable pool. For a given skill query, `NOT status:Archive` returned ~254k vs `status:Active` ~115k vs a positive OR-set (`status:"Online Applicant" OR "New Lead" OR Active`) ~251k.
- Bullhorn **search** applies the `status:` term correctly on the RETURNED records (samples obey the filter) even though `total` counts are relevance-approximate and not a reliable census — get true distributions by reading exact records (e.g. `id:[lo TO hi]`), not by trusting search totals.
- Candidate is **search-only**: `query_entity` on Candidate is rejected ("Query operation not supported for Candidate, please use /search call instead") — always use `search_candidates`/`search_entity`.
- Tool guidance (search_candidates description + query.describe) now encodes the `NOT status:Archive` convention instead of the old misleading `status:"Active"` example.
**Why:** users say "active candidates" meaning workable/non-archived, but this instance's status vocabulary doesn't match that word, so relying on `status:Active` excludes the majority.

## `bullhornUrl` is a server-injected pseudo-field — never forward it to Bullhorn
`bullhornUrl` (the record deep link) is added by OUR server AFTER the fetch (enrichWithProfileUrls), not a real Bullhorn field. Tool descriptions advertise it ("each record has a bullhornUrl deep link"), so the AI naturally tries to request it in `fields` → Bullhorn returns **400 "Invalid field 'bullhornUrl'"** → the client wastes a full retry round-trip. Observed as the recurring "the first search rejected one field name, retrying" stall at the start of nearly every multi-step run (candidates AND jobs). Fix: `sanitizeFields` now strips `bullhornUrl` (case-insensitive) so callers may safely include it; the server still injects it into the response. **Lesson:** any pseudo-field the server adds post-fetch must also be stripped from the inbound `fields` list, or advertising it in guidance turns into a guaranteed wasted retry.

## Candidate search needs FIELD-SCOPED Lucene — bare keywords 400, and free-text mixed with fields silently returns the WRONG set
Bullhorn `/search/Candidate` (this corp) rejects fieldless queries: a bare `clearance` or quoted `"Top Secret"` → **400 "Bad Query" (errors.badSearchQuery)**. Only field-scoped terms parse: `skillSet:Java` (~5,217), `status:Archive`, `willRelocate:true`, `desiredLocations:(...)`.
**DANGER (silent, no error):** combining an unparseable free-text phrase with a valid field term returns a *wrong* set instead of erroring. e.g. `"Reliability Status" AND NOT status:Archive` returned ~59,479 records identical to the **status:Archive** set — i.e. it returned ARCHIVED candidates while asked to EXCLUDE them. So any "résumé keyword" search an AI claims to run via this tool is unreliable and may be inverted.
**Lesson:** there is NO résumé-body free-text search exposed through the bridge today. Keyword discovery must use field-scoped queries (`skillSet`/`certificationList`/`primarySkills`) only. Adding real résumé-text search would be new work (separate Bullhorn capability, not just a query tweak).

## Security clearance is SPARSE structured data, mostly in skillSet — big "clearance count" numbers are artifacts
No dedicated clearance field exists (267 Candidate fields, none clearance/security). Clearance is tagged in `skillSet` for only a handful: active `skillSet:Secret`≈13, `skillSet:Clearance`≈18, `skillSet:"Top Secret"`≈1; `certificationList:Secret`=0, `primarySkills:Secret`=0.
So when an AI reports a large clearance population from search `total` (e.g. "6,069 candidates with clearance terms"), that's a relevance-approximate / broken-query artifact — the true structured count is dozens, not thousands. A résumé mention ≠ a currently-active clearance (clearances lapse). **Trust field-scoped reads, never search `total`.**

## Where the latency actually goes (input→output ~2.5–3 min on deep prompts)
The bulk of a deep prompt's wall-clock is the **GPT model's own reasoning/"thinking"** (e.g. "Thought for 2m 39s"), plus the count of SEQUENTIAL tool round-trips (model thinks → calls tool → reads → thinks again). Our server is fast per call (~0.0–0.2s observed) and the Bullhorn **session/token is already cached** (`bullhorn-auth.ts` module-level `session`, re-auth only on expiry) — so the server is NOT the bottleneck. Levers we control are modest (seconds, not minutes): fewer round-trips, the bullhornUrl-strip above, tight tool descriptions so the model plans fewer exploratory calls. The big lever (model choice / how exhaustive the ask is) lives on the ChatGPT side, not the server.
