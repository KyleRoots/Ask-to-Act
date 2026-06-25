/**
 * Bullhorn stores job applicants and recruiter-driven submissions as the SAME
 * JobSubmission object, separated only by `status`. The platform "Response" tab
 * (job-board / inbound applicants) and the actual submission pipeline therefore
 * look identical to a naive query, which made our tools (and the AI) call mere
 * applicants "submissions."
 *
 * Ground truth (live instance, confirmed with the product owner):
 *   - "New Lead" and "Online Applicant" are the RESPONSE bucket — inbound
 *     applicants the recruiter has NOT yet actioned. These are NOT submissions.
 *   - Every other status ("Internally Submitted", "Client Submission",
 *     "Pipeline", interview/offer/onboarding stages, and their rejections) is a
 *     recruiter-actioned SUBMISSION (or a later pipeline stage).
 *
 * The rule defaults to "submission" for any unknown/blank status. This is the
 * conservative choice for the matcher's "already submitted" exclusion: it keeps
 * the original trust guarantee (never under-report that someone is in the
 * pipeline) while correctly reclassifying the inbound applicant bucket.
 */

/** Inbound applicant statuses — the Bullhorn "Response" bucket. Lowercased. */
const RESPONSE_STATUSES: ReadonlySet<string> = new Set([
  "new lead",
  "online applicant",
]);

export type SubmissionStage = "response" | "submission";

function normalize(status: string | undefined | null): string {
  return (status ?? "").trim().toLowerCase();
}

/** True when the status is an inbound applicant (Response), not a real submission. */
export function isResponseStatus(status: string | undefined | null): boolean {
  return RESPONSE_STATUSES.has(normalize(status));
}

/** True when the status represents a recruiter-actioned submission (or beyond). */
export function isTrueSubmission(status: string | undefined | null): boolean {
  return !isResponseStatus(status);
}

/** Classify a JobSubmission status into its pipeline stage. */
export function classifySubmissionStage(status: string | undefined | null): SubmissionStage {
  return isResponseStatus(status) ? "response" : "submission";
}
