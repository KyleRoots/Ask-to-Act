---
name: JobSubmission status vs. pipeline stage
description: Why Bullhorn job pipeline tabs (Client Submission/Interview/Placement) are NOT JobSubmission.status values, and why hardcoded status->stage mappings in tool descriptions are dangerous.
---

# Pipeline tabs are STAGES, not JobSubmission statuses

The horizontal tabs on a Bullhorn JobOrder Overview (e.g. `Pipeline | Client Submission | Interview | Offer Extended | Placement`) are workflow STAGES, not the `JobSubmission.status` picklist. Verified live: the JobSubmission status picklist contains none of "Client Submission", "Interview", or "Placement". Those stages map to *different entities/actions*:
- **Client Submission** = a **Sendout** (sending the candidate to the client) — separate `Sendout` entity (fields: candidate, clientContact, clientCorporation, jobOrder, jobSubmission, email, user…).
- **Interview** = an Appointment.
- **Placement** = the Placement entity.
- A stage tab like "Offer Extended" may coincidentally share a name with a real status, but that does NOT make every tab a status.

**Rule:** Never bake hardcoded "status -> pipeline bucket" mappings into MCP tool descriptions. They are instance-specific, drift, and make the AI silently substitute a wrong status.

**Why:** A real incident — our `create_job_submission`/`bulk_create_submissions` descriptions claimed `'Offer Extended' -> Client Submission bucket`. When a user asked to set a candidate to "Client Submission", ChatGPT followed the baked-in mapping and advanced the candidate toward **Offer Extended** (a late, sensitive stage) instead. Dangerous wrong write.

**How to apply:**
- Submission tool descriptions must say: status values are instance-specific; ALWAYS call `list_field_options(JobSubmission, status)` and pass an EXACT value; pipeline tabs (Client Submission/Interview/Placement) are stages, not statuses — never substitute one for a status; if the user names a stage, confirm the exact status (or recognise "Client Submission" = Sendout, a separate action).
- Enforce server-side: `createJobSubmission` and `bulkCreateSubmissions` now call `assertPicklistValue("JobSubmission","status",…)` (bulk validates once before the loop) so an invalid status is rejected with the real option list — matching `updateSubmissionStatus`. `assertPicklistValue` fails OPEN (Bullhorn stays final authority).
- True "Client Submission" support would require a **Sendout** write tool (needs a clientContact; verify whether `PUT entity/Sendout` triggers a client email before building). Deferred pending product decision.
