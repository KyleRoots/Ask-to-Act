---
name: Candidate matching for a job
description: Why "match candidates for job X" is a single deterministic server-side tool, and the trust rules it must keep.
---

# Candidate matching is server-side and deterministic, never AI-improvised

There is one tool that owns "match/find/source candidates for job X". Do NOT let the
model recombine get_job + search_candidates + list_submissions_for_job to answer this —
that path is what produced the original trust failure.

**Why:** when matching was improvised across tools, submission status was cross-referenced
by candidate NAME. Name collisions made it report a candidate as "Already submitted" to a
job whose pipeline for that candidate was actually empty. A staffing product that lies about
pipeline state is unusable, so this is the single most important correctness property.

**How to apply / the rules the matcher must always keep:**
- **Submission status is matched by candidate ID, never by name.** Build the submitted-id
  Set from the job's submissions and exclude by ID.
- **The submitted-id Set must be exhaustive — paginate.** Fetching only one page silently
  truncates the Set for any job with more submissions than one page, re-introducing the
  exact "shown as not submitted when they are" bug at scale. Page until a short page.
- **Default exclusions (user-confirmed):** Placed, Already-submitted-to-this-job, Do Not
  Contact / Opted Out, Inactive / Archived. Each is overridable via an `include*` flag.
- **Overrides must actually widen the pool.** A default exclusion enforced at the *search*
  layer (e.g. `NOT status:Archive`) makes the matching `include*` flag a no-op, because the
  excluded records never enter the pool. Gate the search restriction on the flag too, not
  just the post-fetch JS filter.
- **Status filtering uses substring/marker matching, not exact spelling.** Bullhorn status
  spellings vary per tenant; match markers like "placed"/"archive"/"do not contact".
- **Location:** prioritize local/onsite in ranking but still surface strong remote; honor the
  job description's stated location requirement. `localOnly` hard-excludes out-of-area.
- **Lean payload + evidence:** small shortlist, short résumé VERIFY-mode excerpts, and a
  server-injected `bullhornUrl` per candidate. Clearance/skills are NOT structured (they live
  in résumé text) — treat any clearance as UNVERIFIED and back every claim with an evidence quote.
- **Skill derivation fallback:** if the job's `skills` field is empty, requirements fall back
  to title tokens (noisier). The tool guidance tells the model to pass explicit must-have
  skills to refine — prefer that over trusting auto-derived title tokens for important roles.
