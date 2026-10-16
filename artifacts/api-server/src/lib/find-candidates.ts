/**
 * Deterministic ad hoc candidate search — the high-level "find the best people for
 * this ask" pipeline.
 *
 * WHY this exists: the raw `search_candidates` tool returns Bullhorn's text-relevance
 * order as-is, so result quality depended entirely on how cleverly the driving AI
 * phrased the query, expanded synonyms, re-ranked, and fact-checked résumés — and
 * that varied wildly across ChatGPT/Claude/Gemini and even between runs. This tool
 * moves all of that onto the SERVER so quality is consistent regardless of the model:
 *   - RECALL: expand each concept into curated synonym/orthographic OR-groups,
 *   - RANK: re-order by recruiter signals (skill hits, local, recency, availability),
 *   - PRECISION: confirm required terms against the actual résumé for the shortlist,
 *   - EXPERIENCE: derive years/seniority/recency from work history (no structured field).
 *
 * The raw `search_candidates` stays intact as the power-user door; this is the door
 * the AI should reach for by default.
 */
import { searchCandidates, getCandidate } from "./bullhorn-client.js";
import { asArray, entityOf, mapLimit, num, str } from "./record-utils.js";
import { toConcepts } from "./search-taxonomy.js";
import { rankCandidates } from "./search-ranking.js";
import { overlayWorkHistory } from "./relevant-recency.js";
import { verifyConcepts, confirmedConceptIds } from "./search-verify.js";
import { deriveExperience } from "./candidate-experience.js";

export interface FindCandidatesArgs {
  /** Required concepts every candidate should have (skills, titles, clearances). */
  mustHave: string[];
  /** Optional concepts that boost ranking but are not required. */
  niceToHave?: string[];
  /** Prefer (do not hard-filter) candidates in this city. */
  city?: string;
  /** Prefer (do not hard-filter) candidates in this state/province. */
  state?: string;
  /** Requested upstream status phrase; whole-field equality is unverified. */
  status?: string;
  /** Candidate.dateAdded day bounds: UTC inclusive start, exclusive end. */
  dateAddedStart?: string;
  dateAddedEnd?: string;
  /** Exact case-insensitive status values; no tenant-specific alias expansion. */
  excludedStatuses?: string[];
  /** Include Archive status candidates. Default false; not a general inactive-status policy. */
  includeInactive?: boolean;
  /** Drop candidates whose résumé does not confirm at least one required term. Default false. */
  requireResumeConfirmation?: boolean;
  /** How many candidates to return. Default 8, max 20. */
  limit?: number;
  /** Candidate pool to fetch before ranking. Default 60, max 120. */
  poolSize?: number;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const DEFAULT_POOL = 60;
const MAX_POOL = 120;
const VERIFY_CONCURRENCY = 4;
const EXPERIENCE_CONCURRENCY = 4;

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
  "dateAvailable",
  "dateLastModified",
  "dateAdded",
].join(",");

function fullName(c: Record<string, unknown>): string {
  const name = str(c.name).trim();
  if (name) return name;
  const composed = `${str(c.firstName)} ${str(c.lastName)}`.trim();
  return composed || `Candidate ${num(c.id) ?? "?"}`;
}

function locationOf(c: Record<string, unknown>): string {
  const addr = entityOf(c.address);
  return [str(addr.city), str(addr.state)].filter(Boolean).join(", ") || "Unknown";
}

/** Quote a Lucene phrase value, escaping embedded quotes. */
function phrase(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function dateBound(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date (UTC).`);
  }
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date (UTC).`);
  }
  return ms;
}

export async function findCandidates(args: FindCandidatesArgs): Promise<unknown> {
  const mustHave = (args.mustHave ?? []).map((s) => s.trim()).filter(Boolean);
  if (mustHave.length === 0) {
    throw new Error("find_candidates requires at least one mustHave concept.");
  }
  const niceToHave = (args.niceToHave ?? []).map((s) => s.trim()).filter(Boolean);
  const startMs = dateBound(args.dateAddedStart, "dateAddedStart");
  const endMs = dateBound(args.dateAddedEnd, "dateAddedEnd");
  if (startMs !== undefined && endMs !== undefined && endMs <= startMs) {
    throw new Error("dateAddedEnd must be after dateAddedStart (exclusive UTC end).");
  }
  const excludedStatuses: string[] = [];
  const excludedKeys = new Set<string>();
  for (const value of args.excludedStatuses ?? []) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("excludedStatuses must contain non-empty status values.");
    const key = trimmed.toLowerCase();
    if (!excludedKeys.has(key)) {
      excludedKeys.add(key);
      excludedStatuses.push(trimmed);
    }
  }
  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const poolSize = Math.min(Math.max(limit * 4, args.poolSize ?? DEFAULT_POOL), MAX_POOL);

  // 1. RECALL — each required concept becomes its own AND group of OR'd synonyms.
  //    The same concepts (canonical + synonyms) are reused for ranking and résumé
  //    verification so a synonym match is treated identically end-to-end. Nice-to-haves
  //    never constrain the search (that would make them required); they only rank.
  const concepts = toConcepts(mustHave);
  const expandedGroups = concepts.map((c) => c.terms);
  const keywords: Array<string | string[]> = expandedGroups.map((g) => (g.length === 1 ? g[0] : g));

  // 2. Structured query: workable-pool gate + optional exact status. Location is a
  //    ranking PREFERENCE, not a hard filter, so strong out-of-area people still show.
  const queryParts: string[] = [];
  if (!args.includeInactive) queryParts.push("NOT status:Archive");
  if (args.status) queryParts.push(`status:${phrase(args.status)}`);
  // Do not push the new filters into Lucene without index-contract evidence:
  // phrase matching need not be whole-field equality, and a second-resolution
  // end bound could lose the final milliseconds. Filter only this bounded pool.
  const query = queryParts.length ? queryParts.join(" AND ") : undefined;

  const searchRes = await searchCandidates({
    query,
    keywords,
    count: poolSize,
    fields: SEARCH_FIELDS,
  });
  const fetchedPool = asArray(searchRes) as Array<Record<string, unknown>>;
  // Recheck requested exclusions before ranking or fetching any résumé. Missing
  // date evidence cannot satisfy a requested bound. Defaults otherwise stay intact.
  const pool = fetchedPool.filter((candidate) => {
    if (excludedKeys.has(str(candidate.status).trim().toLowerCase())) return false;
    if (startMs !== undefined || endMs !== undefined) {
      const added = num(candidate.dateAdded);
      if (added === null || !Number.isFinite(added)) return false;
      if (startMs !== undefined && added < startMs) return false;
      if (endMs !== undefined && added >= endMs) return false;
    }
    return true;
  });

  const now = Date.now();
  const rankCtx = {
    mustTerms: mustHave,
    mustConcepts: concepts,
    niceTerms: niceToHave,
    jobCity: args.city,
    jobState: args.state,
    now,
  };

  // 3. First-pass rank on structured signals to decide WHO is worth a résumé fetch.
  const firstPass = rankCandidates(pool, rankCtx);
  const verifyCount = Math.min(firstPass.length, limit * 2);
  const verifyPool = firstPass.slice(0, verifyCount);
  const verifyIds = verifyPool.map((r) => r.id).filter((id) => id >= 0);

  // 4. PRECISION — confirm required CONCEPTS (any synonym counts) against the actual
  //    résumé for that top slice.
  const [verified, fullCandidates] = await Promise.all([
    verifyConcepts(verifyIds, concepts, { concurrency: VERIFY_CONCURRENCY }),
    mapLimit(verifyPool, EXPERIENCE_CONCURRENCY, async (r) => {
      try {
        return entityOf(await getCandidate({ id: r.id }));
      } catch {
        return null;
      }
    }),
  ]);
  const verifiedTermsById = new Map<number, string[]>();
  for (const [id, v] of verified) verifiedTermsById.set(id, v.matchedConcepts);
  const fullById = new Map<number, Record<string, unknown>>();
  for (let i = 0; i < verifyPool.length; i++) {
    const full = fullCandidates[i];
    if (full) fullById.set(verifyPool[i].id, full);
  }

  // 5. Final rank WITH résumé-confirmation and dated relevant-role recency.
  let reRanked = rankCandidates(
    verifyPool.map((r) => overlayWorkHistory(r.candidate, fullById.get(r.id))),
    { ...rankCtx, verifiedTermsById },
  );
  let droppedUnconfirmed = 0;
  if (args.requireResumeConfirmation) {
    const keep = confirmedConceptIds(verified);
    const before = reRanked.length;
    reRanked = reRanked.filter((r) => keep.has(r.id));
    droppedUnconfirmed = before - reRanked.length;
  }
  const shortlist = reRanked.slice(0, limit);

  const matches = shortlist.map((r, i) => {
    const c = r.candidate;
    const v = verified.get(r.id);
    const full = fullById.get(r.id);
    const exp = full ? deriveExperience(full, now) : null;
    return {
      rank: i + 1,
      candidateId: r.id,
      name: fullName(c),
      status: str(c.status) || "Unknown",
      location: locationOf(c),
      isLocal: r.signals.isLocal,
      matchScore: r.score,
      reasons: r.reasons,
      matchedSkills: r.signals.structuredSkillHits,
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
      availableSoon: r.signals.availableSoon,
      bullhornUrl: (c as { bullhornUrl?: string }).bullhornUrl ?? null,
    };
  });

  return {
    query: {
      mustHave,
      niceToHave,
      expandedTo: expandedGroups,
      location: [args.city, args.state].filter(Boolean).join(", ") || null,
      status: args.status ?? null,
      includeInactive: !!args.includeInactive,
      dateAddedStart: args.dateAddedStart ?? null,
      dateAddedEnd: args.dateAddedEnd ?? null,
      excludedStatuses,
      requireResumeConfirmation: !!args.requireResumeConfirmation,
    },
    appliedFilters: {
      structuredQuery: query ?? null,
      archiveExcluded: !args.includeInactive,
      upstreamStatus: {
        requestedPhrase: args.status ?? null,
        applied: !!args.status,
        wholeFieldEqualityVerified: false,
      },
      excludedStatuses,
      requestedFilterStage: "fetched_pool_before_ranking",
      dateAdded: {
        field: "Candidate.dateAdded",
        startInclusive: args.dateAddedStart ?? null,
        endExclusive: args.dateAddedEnd ?? null,
        timezone: "UTC",
      },
      location: { city: args.city ?? null, state: args.state ?? null, mode: "ranking_preference" },
      contactHistoryExclusion: { supported: false, applied: false },
    },
    searchScope: {
      exhaustive: false,
      requestedFiltersPushedDown: false,
      poolRequested: poolSize,
      fetched: fetchedPool.length,
      eligibleInFetchedPool: pool.length,
      resumeCheckLimit: limit * 2,
      resultLimit: limit,
    },
    totals: {
      candidatesScanned: fetchedPool.length,
      droppedRequestedFilters: fetchedPool.length - pool.length,
      resumesChecked: verifyIds.length,
      droppedUnconfirmed,
      returned: matches.length,
    },
    matches,
    notes: [
      "Requested date bounds and excluded statuses are applied only within the fetched pool before ranking, not by the upstream search. Eligible records outside that pool may be missed; an empty result does not establish no eligible candidates exist.",
      "Results are highest-ranked within a bounded fetched and résumé-checked pool, not an exhaustive search or a total count of eligible candidates.",
      "City/state are ranking preferences, not hard filters. Report appliedFilters and query.expandedTo when explaining this search.",
      "Positive status is an upstream phrase request; whole-field equality is unverified. This is distinct from exact local excludedStatuses comparisons.",
      "Already-contacted exclusion is unsupported and was not applied; neither candidate status nor job submission proves contact history.",
      "Ranking is deterministic and server-side: structured skill hits, résumé-confirmed skills, current/recent relevant roles, local match, and availability — not just Bullhorn text relevance. Older relevant experience stays in the list; it is not treated as unqualified.",
      "matchedSkills come from structured fields; resumeConfirmed/resumeEvidence are the citable proof from the résumé. Do not claim a skill that is neither in matchedSkills nor resumeConfirmed.",
      "Security clearance is NOT a structured field in Bullhorn; it lives in résumé text. Treat any clearance as UNVERIFIED until confirmed via resumeEvidence, and remember clearances can lapse.",
      "experience is derived from work-history dates (Bullhorn's structured experience field is usually empty); treat it as an estimate.",
      "Open each bullhornUrl to verify the person before acting.",
    ],
  };
}
