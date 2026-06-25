/**
 * Deterministic "match candidates for a job" capability.
 *
 * WHY this exists: matching used to be improvised by the AI across three separate
 * tools (get_job -> search_candidates -> list_submissions_for_job). The AI
 * cross-referenced submissions by NAME, which collides (multiple "Ivan Novikov"),
 * so it reported people as "already submitted" when their pipeline was empty. This
 * module does the trust-critical work server-side and deterministically:
 *   - reads the job and surfaces the requirements it matched against,
 *   - searches candidates against those requirements,
 *   - reliably EXCLUDES unwanted statuses (Placed / Do-Not-Contact / Inactive-
 *     Archived) and anyone ALREADY SUBMITTED TO THIS JOB (matched by candidate ID),
 *   - prioritizes local/onsite candidates while still surfacing strong remote ones,
 *   - returns verifiable Bullhorn deep links plus short résumé evidence quotes.
 *
 * Defaults are user-confirmed; every exclusion is overridable via an include* flag.
 */
import {
  getJob,
  searchCandidates,
  listSubmissionsForJob,
  getCandidate,
} from "./bullhorn-client.js";
import { asArray, entityOf, mapLimit, str } from "./record-utils.js";
import { toConcepts, type Concept } from "./search-taxonomy.js";
import { isLocalMatch as isLocalMatchShared, structuredConceptHits as structuredConceptHitsShared } from "./search-ranking.js";
import { verifyConcepts } from "./search-verify.js";
import { deriveExperience } from "./candidate-experience.js";

export interface MatchCandidatesArgs {
  jobId: number;
  /** Override the must-have skills; otherwise derived from the job's `skills` field. */
  mustHaveSkills?: string[];
  /** Extra nice-to-have terms that boost ranking but are not required. */
  niceToHaveSkills?: string[];
  /** How many matches to return (after filtering). Default 6, max 15. */
  limit?: number;
  /** Candidate pool to fetch before filtering. Default 50, max 100. */
  poolSize?: number;
  /** Drop candidates whose location does not match the job's. Default false. */
  localOnly?: boolean;
  // --- override the default exclusions ---
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

/** Status substrings that mark a candidate as not-to-surface, grouped by reason. */
const STATUS_MARKERS = {
  placed: ["placed"],
  inactive: ["archive", "inactive", "do not place", "unavailable"],
  doNotContact: ["do not contact", "do-not-contact", "dnc", "opted out", "opt out", "opt-out"],
} as const;

interface CandidateRecord {
  id: number;
  firstName?: string;
  lastName?: string;
  name?: string;
  status?: string;
  occupation?: string;
  skillSet?: string;
  address?: { city?: string; state?: string; countryName?: string } | null;
}

/**
 * Collect the candidate IDs of everyone ALREADY SUBMITTED to a job, paginating
 * exhaustively. A job with more submissions than a single page would otherwise
 * yield an incomplete set and re-introduce the "shown as not submitted when they
 * actually are" trust bug. Matched by candidate ID only — never by name.
 */
async function fetchAllSubmittedCandidateIds(jobId: number): Promise<Set<number>> {
  const ids = new Set<number>();
  const PAGE = 200;
  const MAX_PAGES = 50; // safety ceiling: 10k submissions
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listSubmissionsForJob({
      jobId,
      count: PAGE,
      start: page * PAGE,
      fields: "id,candidate(id),status,dateAdded",
    });
    const rows = asArray(res);
    for (const s of rows) {
      const cid = (s as { candidate?: { id?: number } }).candidate?.id;
      if (typeof cid === "number") ids.add(cid);
    }
    if (rows.length < PAGE) break;
  }
  return ids;
}

function fullName(c: CandidateRecord): string {
  return (c.name ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`).trim() || `Candidate ${c.id}`;
}

/** Split a comma/semicolon/newline-delimited skills string into clean terms. */
function splitSkills(raw: string): string[] {
  return raw
    .split(/[,;\n|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length <= 40);
}

/** Detect the job's location requirement from its description. */
function detectLocationRequirement(description: string): "onsite" | "hybrid" | "remote" | "unspecified" {
  const d = description.toLowerCase();
  if (/\bhybrid\b/.test(d)) return "hybrid";
  if (/\b(on-?site|in[- ]office|in[- ]person)\b/.test(d)) return "onsite";
  if (/\b(remote|work from home|wfh|fully remote)\b/.test(d)) return "remote";
  return "unspecified";
}

/** Which exclusion markers are active given the include* overrides. */
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

/** Local-match against the job's city/state, via the shared ranking helper. */
function isLocalMatch(cand: CandidateRecord, jobCity: string, jobState: string): boolean {
  return isLocalMatchShared(cand as unknown as Record<string, unknown>, jobCity, jobState);
}

/**
 * Which required CONCEPTS (canonical + synonyms) appear in the candidate's structured
 * skill fields, reported by canonical label, via the shared concept-aware helper.
 */
function structuredConceptHits(cand: CandidateRecord, concepts: Concept[]): string[] {
  return structuredConceptHitsShared(cand as unknown as Record<string, unknown>, concepts);
}

export async function matchCandidatesForJob(args: MatchCandidatesArgs): Promise<unknown> {
  if (!args.jobId || !Number.isFinite(args.jobId)) {
    throw new Error("match_candidates_for_job requires a numeric jobId.");
  }
  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const poolSize = Math.min(Math.max(limit * 4, args.poolSize ?? DEFAULT_POOL), MAX_POOL);

  // 1. Read the job and derive the requirements we will match against.
  const job = entityOf(await getJob({ id: args.jobId }));
  if (!job.id) {
    throw new Error(`Job ${args.jobId} not found (or not readable).`);
  }
  const jobTitle = str(job.title);
  const jobAddress = (job.address ?? {}) as { city?: string; state?: string };
  const jobCity = str(jobAddress.city);
  const jobState = str(jobAddress.state);
  const description = str(job.publicDescription);
  const locationRequirement = detectLocationRequirement(description);

  const derivedSkills = splitSkills(str(job.skills));
  const mustHave =
    args.mustHaveSkills && args.mustHaveSkills.length > 0
      ? args.mustHaveSkills
      : derivedSkills.length > 0
        ? derivedSkills
        : // Fall back to the title so we never run an empty search.
          jobTitle.split(/\s+/).filter((w) => w.length > 2);
  const niceToHave = args.niceToHaveSkills ?? [];

  if (mustHave.length === 0) {
    throw new Error(
      `Job ${args.jobId} has no skills/title to match on. Pass mustHaveSkills explicitly.`,
    );
  }

  // 2. Search candidates: each must-have is its own AND group (so all are required),
  //    EXPANDED into curated synonyms/orthographic variants for recall (e.g. "react"
  //    also matches "reactjs"/"react.js"). Nice-to-haves widen recall as a single OR
  //    group. We restrict the search to the workable (non-archived) pool ONLY when
  //    archived candidates are excluded — when the caller opts in via includeInactive,
  //    we must NOT hard-filter them out here or the override could never surface them.
  const mustConcepts = toConcepts(mustHave);
  const keywords: Array<string | string[]> = mustConcepts.map((c) =>
    c.terms.length === 1 ? c.terms[0] : c.terms,
  );
  if (niceToHave.length > 0) keywords.push(niceToHave);

  const [searchRes, submittedIds] = await Promise.all([
    searchCandidates({
      query: args.includeInactive ? undefined : "NOT status:Archive",
      keywords,
      count: poolSize,
      fields: "id,firstName,lastName,name,status,occupation,skillSet,address",
    }),
    // 3. Build the set of candidates ALREADY SUBMITTED TO THIS JOB — by candidate ID,
    //    never by name (the trust fix). Paginate exhaustively: a job with >200
    //    submissions would otherwise yield an incomplete set and re-introduce the
    //    "shown as not submitted when they are" bug at scale.
    fetchAllSubmittedCandidateIds(args.jobId),
  ]);

  const pool = asArray(searchRes) as CandidateRecord[];

  // 4. Filter the pool deterministically.
  const markers = activeExclusionMarkers(args);
  const excludedSummary = { placed: 0, inactive: 0, doNotContact: 0, alreadySubmitted: 0, outOfArea: 0 };
  const kept: CandidateRecord[] = [];

  for (const c of pool) {
    if (!c || typeof c.id !== "number") continue;
    const status = str(c.status);
    const hit = statusExcludedBy(status, markers);
    if (hit) {
      if (STATUS_MARKERS.placed.includes(hit as never)) excludedSummary.placed++;
      else if (STATUS_MARKERS.doNotContact.includes(hit as never)) excludedSummary.doNotContact++;
      else excludedSummary.inactive++;
      continue;
    }
    if (!args.includeSubmitted && submittedIds.has(c.id)) {
      excludedSummary.alreadySubmitted++;
      continue;
    }
    if (args.localOnly && !isLocalMatch(c, jobCity, jobState)) {
      excludedSummary.outOfArea++;
      continue;
    }
    kept.push(c);
  }

  // 5. Score: local priority, then structured-skill overlap (concept-aware so a synonym
  //    counts the same as an exact term), preserving Bullhorn's relevance order as the
  //    final tiebreak.
  const allConcepts = toConcepts([...mustHave, ...niceToHave]);
  const scored = kept.map((c, idx) => {
    const hits = structuredConceptHits(c, allConcepts);
    const local = isLocalMatch(c, jobCity, jobState);
    return { cand: c, hits, local, relevanceRank: idx };
  });
  scored.sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    if (a.hits.length !== b.hits.length) return b.hits.length - a.hits.length;
    return a.relevanceRank - b.relevanceRank;
  });

  const shortlist = scored.slice(0, limit);

  // 6. Résumé PRECISION + EXPERIENCE for the shortlist ONLY (small payload), via the
  //    shared helpers so ad hoc search and matching fact-check identically. Verify the
  //    must-have terms against the actual résumé; derive years/seniority/recency from
  //    work-history dates (Bullhorn's structured experience field is usually empty).
  const shortlistIds = shortlist.map((s) => s.cand.id);
  const now = Date.now();
  const [verified, experiences] = await Promise.all([
    verifyConcepts(shortlistIds, mustConcepts, { concurrency: RESUME_CONCURRENCY }),
    mapLimit(shortlist, EXPERIENCE_CONCURRENCY, async (s) => {
      try {
        return deriveExperience(entityOf(await getCandidate({ id: s.cand.id })), now);
      } catch {
        return null;
      }
    }),
  ]);

  const matches = shortlist.map((s, i) => {
    const c = s.cand;
    const v = verified.get(c.id);
    const exp = experiences[i];
    return {
      rank: i + 1,
      candidateId: c.id,
      name: fullName(c),
      status: str(c.status) || "Unknown",
      location: [str(c.address?.city), str(c.address?.state)].filter(Boolean).join(", ") || "Unknown",
      isLocal: s.local,
      alreadySubmitted: submittedIds.has(c.id),
      matchedSkills: s.hits,
      resumeConfirmed: v?.matchedConcepts ?? [],
      resumeMissing: v?.missingConcepts ?? mustHave,
      resumeEvidence: v?.excerpts ?? [],
      experience: exp
        ? {
            yearsExperience: exp.yearsExperience,
            seniority: exp.seniority,
            currentRole: exp.currentRole,
            lastActivityMonthsAgo: exp.lastActivityMonthsAgo,
          }
        : null,
      bullhornUrl: (c as { bullhornUrl?: string }).bullhornUrl ?? null,
    };
  });

  return {
    job: {
      id: job.id,
      title: jobTitle || "(untitled)",
      location: [jobCity, jobState].filter(Boolean).join(", ") || "Unspecified",
      locationRequirement,
      employmentType: str(job.employmentType) || null,
      yearsRequired: typeof job.yearsRequired === "number" ? job.yearsRequired : null,
      skillsMatchedAgainst: mustHave,
      niceToHaves: niceToHave,
      bullhornUrl: (job as { bullhornUrl?: string }).bullhornUrl ?? null,
    },
    defaultsApplied: {
      excludedByDefault: [
        !args.includePlaced ? "Placed" : null,
        !args.includeSubmitted ? "Already submitted to this job" : null,
        !args.includeDoNotContact ? "Do Not Contact / Opted Out" : null,
        !args.includeInactive ? "Inactive / Archived" : null,
      ].filter(Boolean),
      localPriority: !args.localOnly,
      localOnly: !!args.localOnly,
    },
    totals: {
      candidatesScanned: pool.length,
      excluded: excludedSummary,
      matchesReturned: matches.length,
    },
    matches,
    notes: [
      "Submission status is matched by candidate ID (not name), so it is verifiable — open each bullhornUrl to confirm.",
      "Security clearance is NOT a structured field in Bullhorn; it lives in résumé text. Treat any clearance as UNVERIFIED until confirmed via get_candidate_resume (VERIFY mode) and remember clearances can lapse.",
      "matchedSkills come from structured fields; resumeEvidence quotes are the citable proof. Do not claim a skill without evidence.",
    ],
  };
}
