---
name: Bullhorn Response vs Submission distinction
description: The product rule separating job applicants (Response bucket) from real submissions, and where it must be enforced.
---

# Response (applicant) vs Submission (recruiter-actioned)

Bullhorn stores inbound applicants and recruiter-driven submissions as the **same
JobSubmission object**, separated only by `status`. The platform "Response" tab
(job-board / inbound applicants) and the real submission pipeline look identical
to a naive `jobOrder.id=X` query, so tools (and the AI) used to call mere
applicants "submissions."

**The rule (product-owner confirmed):**
- **Response / applicant** = statuses `New Lead` and `Online Applicant`. NOT submissions.
- **Submission (or later)** = everything else: `Internally Submitted`, `Client
  Submission`, `Pipeline`, interview/offer/onboarding stages, and their rejections.
- Default any unknown/blank status to **submission** — conservative, preserves the
  "never under-report that someone is already in the pipeline" trust guarantee.

**Why:** Job 35233 had 106 JobSubmission rows = 105 `New Lead` (applicants) + 1
`Client Submission`. The matcher was excluding all 105 applicants as "already
submitted," and the list tool reported them as submissions — both wrong.

**Decision for the matcher:** applicants are still **shown** as matches, just
flagged `alreadyApplied`; only **true submissions** are hidden as
`alreadySubmitted` (unless `includeSubmitted`).

**How to apply / where it lives:** classification is centralized in
`submission-status.ts` (`isResponseStatus` / `isTrueSubmission` /
`classifySubmissionStage`). `listSubmissionsForJob` tags every row with `stage`
+ a `stageSummary`. The matcher splits the pile into `submitted` vs `applied`
sets. Any new tool that surfaces JobSubmission rows MUST route through this
classifier, never count raw rows as "submissions."

**Note:** these status strings are the legacy in-use values; the configured
picklist (`Pipeline, Online Applicant, Internally Submitted, …`) does NOT include
`New Lead`/`Client Submission`. Trust the live status values on records over the
picklist (classic Bullhorn legacy-status drift). Status match is case-insensitive
+ exact (trimmed); other instances may use different applicant labels — re-probe
per tenant before assuming.
