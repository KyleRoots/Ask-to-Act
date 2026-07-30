/**
 * Deterministic "match candidates for a job" capability.
 *
 * Matching is server-side and evidence-aware:
 *   - reads structured JobOrder requirements (onSite, years, sponsorship, pay),
 *   - searches with concept expansion (nice-to-haves never AND into the query),
 *   - excludes unwanted statuses and true submissions by candidate ID,
 *   - evaluates location / experience / authorization / skills as pass|fail|unknown,
 *   - ranks with shared recruiter signals (no unconditional local boost for remote roles),
 *   - returns eligible vs needs-verification buckets with transparent criterion outcomes.
 */
import {
  getJob,
  searchCandidates,
  listSubmissionsForJob,
  getCandidate,
} from "./bullhorn-client.js";
import { asArray, entityOf, mapLimit, num, str } from "./record-utils.js";
import { toConcepts } from "./search-taxonomy.js";
import { rankCandidates } from "./search-ranking.js";
import { verifyConcepts } from "./search-verify.js";
import { deriveExperience } from "./candidate-experience.js";
import {
  RESUME_EXPERIENCE_PROBE_TERMS,
  parseResumeYears,
  reconcileExperience,
} from "./resume-experience.js";
import type { ReconciledExperience } from "./resume-experience.js";
import { isTrueSubmission } from "./submission-status.js";
import { extractJobRequirements } from "./match-requirements.js";
import { evaluateCandidate } from "./match-criteria.js";

export interface MatchCandidatesArgs {
  jobId: number;
  /** Override the must-have skills; otherwise derived from the job's skills/skillList. */
  mustHaveSkills?: string[];
  /** Extra nice-to-have terms that boost ranking but are not required. */
  niceToHaveSkills?: string[];
  /** How many matches to return (after filtering). Default 6, max 15. */
  limit?: number;
  /** Candidate pool to fetch before filtering. Default 50, max 100. */
  poolSize?: number;
  /** Drop candidates whose location does not match the job's. Default false. */
  localOnly?: boolean;
  includePlaced?: boolean;
  includeSubmitted?: boolean;
  includeDoNotContact?: boolean;
  includeInactive?: boolean;
}

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 15;
const DEFAULT_POOL = 50;
const MAX_POOL = 100;
const RESUME_CONCURRENCY = 4;
const EXPERIENCE_CONCURRENCY = 4;

const STATUS_MARKERS = {
  placed: ["placed"],
  inactive: ["archive", "inactive", "do not place", "unavailable"],
  doNotContact: ["do not contact", "do-not-contact", "dnc", "opted out", "opt out", "opt-out"],
} as const;

const SEARCH_FIELDS = [
  "id",
  "firstName",
  "lastName",
  "name",
  "status",
  "occupation",
  "skillSet",
  "primarySkills(id,name)",
  "secondarySkills(id,name)",
  "address(city,state,countryName)",
  "desiredLocations",
  "willRelocate",
  "workAuthorized",
  "employmentPreference",
  "employeeType",
  "experience",
  "salary",
  "hourlyRate",
  "dateAvailable",
  "dateLastModified",
  "dateAdded",
].join(",");

async function fetchJobPipelineCandidateIds(
  jobId: number,
): Promise<{ submitted: Set<number>; applied: Set<number>; pagesFetched: number; truncated: boolean }> {
  const submitted = new Set<number>();
  const applied = new Set<number>();
  const PAGE = 200;
  const MAX_PAGES = 50;
  let pagesFetched = 0;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listSubmissionsForJob({
      jobId,
      count: PAGE,
      start: page * PAGE,
      fields: "id,candidate(id),status,dateAdded",
    });
    pagesFetched++;
    const rows = asArray(res);
    for (const s of rows) {
      const cid = (s as { candidate?: { id?: number } }).candidate?.id;
      if (typeof cid !== "number") continue;
      const status = str((s as { status?: unknown }).status);
      if (isTrueSubmission(status)) submitted.add(cid);
      else applied.add(cid);
    }
    if (rows.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { submitted, applied, pagesFetched, truncated };
}

function fullName(c: Record<string, unknown>): string {
  const name = str(c.name).trim();
  if (name) return name;
  return `${str(c.firstName)} ${str(c.lastName)}`.trim() || `Candidate ${num(c.id) ?? "?"}`;
}

function locationOf(c: Record<string, unknown>): string {
  const addr = entityOf(c.address);
  return [str(addr.city), str(addr.state)].filter(Boolean).join(", ") || "Unknown";
}

function activeExclusionMarkers(args: MatchCandidatesArgs): string[] {
  const markers: string[] = [];
  if (!args.includePlaced) markers.push(...STATUS_MARKERS.placed);
  if (!args.includeInactive) markers.push(...STATUS_MARKERS.inactive);
  if (!args.includeDoNotContact) markers.push(...STATUS_MARKERS.doNotContact);
  return markers;
}

function statusExcludedBy(status: string, markers: string[]): string | null {
  const s = status.toLowerCase();
  for (const m of markers) if (s.includes(m)) return m;
  return null;
}

function phrase(v: string): string {
  return `"${v.replace(/"/g, '\\"')}"`;
}

function mergePools(
  primary: Array<Record<string, unknown>>,
  secondary: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<number>();
  const out: Array<Record<string, unknown>> = [];
  for (const pool of [primary, secondary]) {
    for (const c of pool) {
      const id = num(c.id);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      out.push(c);
    }
  }
  return out;
}

export async function matchCandidatesForJob(args: MatchCandidatesArgs): Promise<unknown> {
  if (!args.jobId || !Number.isFinite(args.jobId)) {
    throw new Error("match_candidates_for_job requires a numeric jobId.");
  }
  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const poolSize = Math.min(Math.max(limit * 4, args.poolSize ?? DEFAULT_POOL), MAX_POOL);

  // 1. Read the job and extract structured requirements.
  const job = entityOf(await getJob({ id: args.jobId }));
  if (!job.id) {
    throw new Error(`Job ${args.jobId} not found (or not readable).`);
  }
  const requirements = extractJobRequirements({
    job,
    mustHaveSkills: args.mustHaveSkills,
    niceToHaveSkills: args.niceToHaveSkills,
  });

  if (requirements.mustHaveSkills.length === 0) {
    return {
      status: "needs_clarification",
      job: {
        id: job.id,
        title: requirements.title,
        location: requirements.locationLabel,
        locationRequirement: requirements.workArrangement,
        bullhornUrl: (job as { bullhornUrl?: string }).bullhornUrl ?? null,
      },
      parsedRequirements: requirements.parsedRequirements,
      message:
        "This job has no usable skills/title to match on. Pass mustHaveSkills (e.g. key technologies) and retry.",
      eligibleMatches: [],
      needsVerification: [],
      matches: [],
    };
  }

  if (requirements.skillDerivation === "title_fallback") {
    // Soft clarification signal — still run, but mark partial confidence.
  }

  const mustConcepts = toConcepts(requirements.mustHaveSkills);
  // Nice-to-haves must NEVER become AND search groups (that would make them required).
  const keywords: Array<string | string[]> = mustConcepts.map((c) =>
    c.terms.length === 1 ? c.terms[0] : c.terms,
  );

  const baseQueryParts: string[] = [];
  if (!args.includeInactive) baseQueryParts.push("NOT status:Archive");
  const baseQuery = baseQueryParts.length ? baseQueryParts.join(" AND ") : undefined;

  const preferLocal =
    requirements.workArrangement !== "remote" &&
    requirements.workArrangement !== "no_preference";

  // Location-aware second pass for onsite/hybrid so locals aren't missed solely
  // because they fell outside the first keyword-ranked page.
  const locationQueryParts = [...baseQueryParts];
  if (
    preferLocal &&
    (requirements.jobCity || requirements.jobState)
  ) {
    const locClauses: string[] = [];
    if (requirements.jobCity) locClauses.push(`address.city:${phrase(requirements.jobCity)}`);
    if (requirements.jobState) locClauses.push(`address.state:${phrase(requirements.jobState)}`);
    locClauses.push("willRelocate:1");
    locationQueryParts.push(`(${locClauses.join(" OR ")})`);
  }
  const locationQuery =
    locationQueryParts.length > baseQueryParts.length
      ? locationQueryParts.join(" AND ")
      : null;

  const [keywordSearch, locationSearch, pipeline] = await Promise.all([
    searchCandidates({
      query: baseQuery,
      keywords,
      count: poolSize,
      fields: SEARCH_FIELDS,
    }),
    locationQuery
      ? searchCandidates({
          query: locationQuery,
          keywords,
          count: Math.min(poolSize, 40),
          fields: SEARCH_FIELDS,
        })
      : Promise.resolve({ data: [] }),
    fetchJobPipelineCandidateIds(args.jobId),
  ]);

  const pool = mergePools(
    asArray(keywordSearch) as Array<Record<string, unknown>>,
    asArray(locationSearch) as Array<Record<string, unknown>>,
  );
  const submittedIds = pipeline.submitted;
  const appliedIds = pipeline.applied;

  // 2. Status / submission / localOnly hard filters (pre-evaluation).
  const markers = activeExclusionMarkers(args);
  const excludedSummary = {
    placed: 0,
    inactive: 0,
    doNotContact: 0,
    alreadySubmitted: 0,
    outOfArea: 0,
    hardConstraintFail: 0,
  };
  let alreadyAppliedShown = 0;
  const kept: Array<Record<string, unknown>> = [];

  for (const c of pool) {
    const id = num(c.id);
    if (id === null) continue;
    const status = str(c.status);
    const hit = statusExcludedBy(status, markers);
    if (hit) {
      if (STATUS_MARKERS.placed.includes(hit as never)) excludedSummary.placed++;
      else if (STATUS_MARKERS.doNotContact.includes(hit as never)) excludedSummary.doNotContact++;
      else excludedSummary.inactive++;
      continue;
    }
    if (!args.includeSubmitted && submittedIds.has(id)) {
      excludedSummary.alreadySubmitted++;
      continue;
    }
    if (appliedIds.has(id)) alreadyAppliedShown++;
    kept.push(c);
  }

  const now = Date.now();
  const firstPass = rankCandidates(kept, {
    mustTerms: requirements.mustHaveSkills,
    mustConcepts,
    niceTerms: requirements.niceToHaveSkills,
    jobCity: requirements.jobCity,
    jobState: requirements.jobState,
    preferLocal,
    now,
  });

  // Verify + experience for a slice larger than limit so we can fill both buckets.
  const verifyCount = Math.min(firstPass.length, Math.max(limit * 3, limit));
  const verifyPool = firstPass.slice(0, verifyCount);
  const verifyIds = verifyPool.map((r) => r.id).filter((id) => id >= 0);

  const [verified, experiences] = await Promise.all([
    verifyConcepts(verifyIds, mustConcepts, {
      concurrency: RESUME_CONCURRENCY,
      probeTerms: RESUME_EXPERIENCE_PROBE_TERMS,
    }),
    mapLimit(verifyPool, EXPERIENCE_CONCURRENCY, async (r) => {
      try {
        return deriveExperience(entityOf(await getCandidate({ id: r.id })), now);
      } catch {
        return null;
      }
    }),
  ]);

  const verifiedTermsById = new Map<number, string[]>();
  for (const [id, v] of verified) verifiedTermsById.set(id, v.matchedConcepts);
  const experienceById = new Map<number, (typeof experiences)[number]>();
  for (let i = 0; i < verifyPool.length; i++) {
    experienceById.set(verifyPool[i].id, experiences[i] ?? null);
  }

  const reRanked = rankCandidates(
    verifyPool.map((r) => r.candidate),
    {
      mustTerms: requirements.mustHaveSkills,
      mustConcepts,
      niceTerms: requirements.niceToHaveSkills,
      jobCity: requirements.jobCity,
      jobState: requirements.jobState,
      preferLocal,
      now,
      verifiedTermsById,
    },
  );

  type BuiltMatch = {
    rank?: number;
    candidateId: number;
    name: string;
    status: string;
    location: string;
    isLocal: boolean;
    locationFit: string;
    alreadySubmitted: boolean;
    alreadyApplied: boolean;
    matchedSkills: string[];
    resumeConfirmed: string[];
    resumeMissing: string[];
    resumeEvidence: Array<{ term: string; text: string }>;
    experience: {
      yearsExperience: number | null;
      seniority: string;
      currentRole: { title: string; company: string } | null;
      lastActivityMonthsAgo: number | null;
      yearsFromWorkHistory: number | null;
      yearsFromResume: number | null;
      experienceAgreement: ReconciledExperience["agreement"];
      resumeExperienceQuote: string | null;
    } | null;
    matchScore: number;
    reasons: string[];
    criteria: ReturnType<typeof evaluateCandidate>["criteria"];
    eligible: boolean;
    needsVerification: boolean;
    bullhornUrl: string | null;
  };

  const eligibleMatches: BuiltMatch[] = [];
  const needsVerificationMatches: BuiltMatch[] = [];
  const allBuilt: BuiltMatch[] = [];

  for (let i = 0; i < reRanked.length; i++) {
    const ranked = reRanked[i];
    const c = ranked.candidate;
    const id = ranked.id;
    const v = verified.get(id);
    const exp = experienceById.get(id) ?? null;
    const resumeConfirmed = v?.matchedConcepts ?? [];
    const resumeMissing = v?.missingConcepts ?? requirements.mustHaveSkills;
    const resumeYears = parseResumeYears(v?.probeExcerpts);
    const reconciledExperience = reconcileExperience(
      resumeYears?.years ?? null,
      exp?.yearsExperience ?? null,
      resumeYears?.evidence ?? null,
    );

    const evaluation = evaluateCandidate({
      candidate: c,
      requirements,
      mustConcepts,
      resumeConfirmed,
      resumeMissing,
      experience: exp,
      reconciledExperience,
      localOnly: !!args.localOnly,
    });

    if (!evaluation.eligible) {
      excludedSummary.hardConstraintFail++;
      continue;
    }

    // localOnly already applied inside evaluateCandidate as a hard fail.
    if (args.localOnly && evaluation.locationFit === "out_of_area") {
      excludedSummary.outOfArea++;
      continue;
    }

    const built: BuiltMatch = {
      candidateId: id,
      name: fullName(c),
      status: str(c.status) || "Unknown",
      location: locationOf(c),
      isLocal: ranked.signals.isLocal,
      locationFit: evaluation.locationFit,
      alreadySubmitted: submittedIds.has(id),
      alreadyApplied: appliedIds.has(id),
      matchedSkills: ranked.signals.structuredSkillHits,
      resumeConfirmed,
      resumeMissing,
      resumeEvidence: v?.excerpts ?? [],
      experience: exp
        ? {
            yearsExperience: reconciledExperience.years ?? exp.yearsExperience,
            seniority: exp.seniority,
            currentRole: exp.currentRole,
            lastActivityMonthsAgo: exp.lastActivityMonthsAgo,
            // Bullhorn's parsed work history is unreliable on this instance, so both
            // sources are shown and disagreement is stated rather than hidden.
            yearsFromWorkHistory: exp.yearsExperience,
            yearsFromResume: reconciledExperience.resumeYears,
            experienceAgreement: reconciledExperience.agreement,
            resumeExperienceQuote: reconciledExperience.evidence,
          }
        : null,
      matchScore: ranked.score,
      reasons: ranked.reasons,
      criteria: evaluation.criteria,
      eligible: evaluation.eligible,
      needsVerification: evaluation.needsVerification,
      bullhornUrl: typeof c.bullhornUrl === "string" ? c.bullhornUrl : null,
    };
    allBuilt.push(built);
    if (evaluation.needsVerification) needsVerificationMatches.push(built);
    else eligibleMatches.push(built);
  }

  const takeEligible = eligibleMatches.slice(0, limit);
  const remainingSlots = Math.max(0, limit - takeEligible.length);
  const takeNeeds = needsVerificationMatches.slice(0, remainingSlots);
  const matches = [...takeEligible, ...takeNeeds].map((m, i) => ({ ...m, rank: i + 1 }));

  const poolCapped = pool.length >= poolSize || (locationQuery != null && asArray(locationSearch).length >= 40);
  const verificationIncomplete = verifyCount < kept.length;
  let status: "complete" | "partial" | "needs_clarification" | "no_eligible_matches" = "complete";
  if (matches.length === 0) status = "no_eligible_matches";
  else if (poolCapped || verificationIncomplete || pipeline.truncated || requirements.skillDerivation === "title_fallback") {
    status = "partial";
  }

  const stopReasons: string[] = [];
  if (poolCapped) stopReasons.push(`search_pool_capped_at_${poolSize}`);
  if (verificationIncomplete) stopReasons.push("résumé_verification_limited_to_shortlist");
  if (pipeline.truncated) stopReasons.push("submission_pagination_safety_ceiling");
  if (requirements.skillDerivation === "title_fallback") {
    stopReasons.push("skills_derived_from_title_tokens");
  }

  const presentationGuidance = [
    status === "partial"
      ? `Say "highest-ranked among ${kept.length} evaluated" — do NOT say best overall, fully qualified, or no better matches exist.`
      : status === "no_eligible_matches"
        ? "No eligible matches after hard constraints. Do not invent candidates; offer to relax constraints or clarify must-have skills."
        : "Eligible matches passed hard constraints with verified evidence where required.",
    "Never claim a skill without resumeEvidence. Treat clearance as UNVERIFIED until résumé-confirmed.",
    "Link each candidate NAME to bullhornUrl. Leave emails/phones as plain text.",
  ];

  return {
    status,
    job: {
      id: job.id,
      title: requirements.title,
      location: requirements.locationLabel,
      locationRequirement: requirements.workArrangement,
      locationRequirementSource: requirements.workArrangementSource,
      employmentType: requirements.employmentType,
      yearsRequired: requirements.yearsRequired,
      willSponsor: requirements.willSponsor,
      compensation: requirements.compensation,
      skillsMatchedAgainst: requirements.mustHaveSkills,
      niceToHaves: requirements.niceToHaveSkills,
      skillDerivation: requirements.skillDerivation,
      bullhornUrl: (job as { bullhornUrl?: string }).bullhornUrl ?? null,
    },
    parsedRequirements: requirements.parsedRequirements,
    defaultsApplied: {
      excludedByDefault: [
        !args.includePlaced ? "Placed" : null,
        !args.includeSubmitted ? "Already submitted to this job" : null,
        !args.includeDoNotContact ? "Do Not Contact / Opted Out" : null,
        !args.includeInactive ? "Inactive / Archived" : null,
      ].filter(Boolean),
      localPriority: preferLocal && !args.localOnly,
      localOnly: !!args.localOnly,
      preferLocal,
    },
    totals: {
      candidatesScanned: pool.length,
      candidatesEvaluated: verifyPool.length,
      verificationAttempts: verifyIds.length,
      excluded: excludedSummary,
      alreadyAppliedShown,
      eligibleCount: eligibleMatches.length,
      needsVerificationCount: needsVerificationMatches.length,
      matchesReturned: matches.length,
      poolSizeRequested: poolSize,
      submissionPagesFetched: pipeline.pagesFetched,
    },
    completeness: {
      poolCapped,
      verificationIncomplete,
      submissionSetTruncated: pipeline.truncated,
      stopReasons,
    },
    eligibleMatches: takeEligible.map((m, i) => ({ ...m, rank: i + 1 })),
    needsVerification: takeNeeds.map((m, i) => ({ ...m, rank: takeEligible.length + i + 1 })),
    // Backward-compatible flat list (eligible first, then needs-verification).
    matches,
    presentationGuidance,
    notes: [
      "Submission status is matched by candidate ID (not name), so it is verifiable — open each bullhornUrl to confirm.",
      "`alreadySubmitted` means a TRUE submission (Internally Submitted, Client Submission, or later) — these are excluded by default. `alreadyApplied` means the person is only in the job's inbound applicant / Response bucket; they are NOT a submission and are still shown as matches.",
      "Hard constraints use pass|fail|unknown. Unknowns go in needsVerification — never present them as fully qualified.",
      "Work authorization is never inferred from nationality, address, or visa-type labels — only workAuthorized / job willSponsor.",
      "matchedSkills come from structured fields; resumeEvidence quotes are the citable proof.",
      ...presentationGuidance,
    ],
  };
}
