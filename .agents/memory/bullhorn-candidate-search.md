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
