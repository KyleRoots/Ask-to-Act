---
name: Candidate search quality (concept threading)
description: Why search/ranking/verify must all reason over CONCEPTS (canonical + synonyms), not raw terms.
---

# Candidate search quality — concept threading

Both candidate-search doors (ad hoc `find_candidates` and `match_candidates_for_job`) run one
deterministic, server-side pipeline: expand → search → rank → résumé-verify → re-rank → experience.
Quality lives in the tool, not the host model (model-agnostic, no per-call LLM cost).

## The rule
Synonym expansion must flow through EVERY stage, not just search. A `Concept` carries a `canonical`
label plus all its synonyms/variants. Search, structured ranking hits, and résumé verification all
treat a concept as satisfied if ANY synonym matches, and report it under the canonical label.

**Why:** the first cut expanded synonyms only for the Bullhorn keyword SEARCH, but ranking and
résumé verification still compared against the raw query term. A candidate surfaced via a synonym
(résumé says "Amazon Web Services" for a query of "AWS") was then under-scored and — under
`requireResumeConfirmation` — wrongly hard-dropped. Architect flagged this as high-impact FAIL.

**How to apply:** build concepts once at the top of each pipeline; reuse the same concept list for
keyword groups, structured-hit scoring, and the résumé highlight call. Map matched synonyms back to
the canonical label before scoring/output so a synonym hit is indistinguishable from an exact hit.
The strict filter must key off "did any concept confirm" (not "did the raw term confirm").

## Gotchas
- Concept verification fails CLOSED on a résumé-fetch error (nothing confirmed) so strict mode never
  keeps a candidate on missing evidence; the looser per-term verify path fails open for soft claims.
- Don't expand ambiguous short tokens (e.g. bare "TS" ↔ TypeScript collides with Top Secret) — the
  taxonomy guards these; expansion is directional (typescript→ts, not ts→typescript).
- Keep payloads lean (shortlist + short canonical evidence) for the ChatGPT bulk-PII constraint.
