/**
 * Recruiter-signal re-ranking.
 *
 * Bullhorn ranks search hits on text relevance alone. It has no idea which of those
 * people a recruiter would actually want first: who is recently active, available,
 * local, in a workable status, and who genuinely has the required skills (structured
 * AND résumé-confirmed). This module re-ranks a pool by those signals while keeping
 * Bullhorn's relevance order as the final tiebreak, and surfaces transparent reasons
 * so the AI can explain WHY each candidate ranked where it did.
 */

import { asArray, num, recordOf, str } from "./record-utils.js";
import type { Concept } from "./search-taxonomy.js";

export interface RankContext {
  /** Required concept labels (used when `mustConcepts` is not supplied). */
  mustTerms: string[];
  /**
   * Required concepts WITH their synonyms. When provided, a concept counts as a
   * structured hit if ANY of its synonyms appears, and is reported by its canonical
   * label — so synonym matches are scored identically to exact matches.
   */
  mustConcepts?: Concept[];
  /** Optional bonus concepts. */
  niceTerms?: string[];
  jobCity?: string;
  jobState?: string;
  now?: number;
  /** Optional résumé-confirmed concept labels per candidate id (from the verify step). */
  verifiedTermsById?: Map<number, string[]>;
}

export interface RankedCandidate {
  candidate: Record<string, unknown>;
  id: number;
  score: number;
  reasons: string[];
  signals: {
    structuredSkillHits: string[];
    verifiedSkillHits: string[];
    niceHits: string[];
    isLocal: boolean;
    recencyDays: number | null;
    availableSoon: boolean;
    workableStatus: boolean;
  };
}

const W = {
  structuredSkill: 10,
  verifiedSkill: 6,
  niceSkill: 3,
  local: 8,
  availability: 5,
  workableStatus: 3,
  recencyRecent: 5, // <=30d
  recencyWarm: 3, // <=90d
  recencyMild: 1, // <=180d
};

const WORKABLE_STATUS_HINTS = [
  "active",
  "online applicant",
  "new lead",
  "available",
  "contacted",
  "interviewing",
  "prospect",
  "submitted",
];

function lc(s: string): string {
  return s.trim().toLowerCase();
}

/** Text blob of a candidate's STRUCTURED skill-ish fields (not the résumé). */
function structuredSkillText(cand: Record<string, unknown>): string {
  const parts: string[] = [str(cand.skillSet), str(cand.occupation)];
  for (const key of ["primarySkills", "secondarySkills"]) {
    for (const s of asArray(cand[key])) {
      parts.push(str(recordOf(s).name));
    }
  }
  return lc(parts.join(" | "));
}

/** Which of `terms` appear in the candidate's structured skill fields. */
export function structuredSkillHits(cand: Record<string, unknown>, terms: string[]): string[] {
  if (terms.length === 0) return [];
  const blob = structuredSkillText(cand);
  const hits: string[] = [];
  for (const t of terms) {
    const term = lc(t);
    if (term && blob.includes(term)) hits.push(t);
  }
  return hits;
}

/**
 * Concept-aware structured hits: a concept counts (reported by its canonical label)
 * if ANY of its synonyms appears in the candidate's structured skill fields.
 */
export function structuredConceptHits(cand: Record<string, unknown>, concepts: Concept[]): string[] {
  if (concepts.length === 0) return [];
  const blob = structuredSkillText(cand);
  const hits: string[] = [];
  for (const c of concepts) {
    if (c.terms.some((t) => {
      const term = lc(t);
      return term.length > 0 && blob.includes(term);
    })) {
      hits.push(c.canonical);
    }
  }
  return hits;
}

export function isLocalMatch(
  cand: Record<string, unknown>,
  jobCity: string | undefined,
  jobState: string | undefined,
): boolean {
  if (!jobCity && !jobState) return false;
  const addr = recordOf(cand.address);
  const city = lc(str(addr.city));
  const state = lc(str(addr.state));
  if (jobCity && city && city === lc(jobCity)) return true;
  if (jobState && state && state === lc(jobState)) return true;
  return false;
}

function recencyDays(cand: Record<string, unknown>, now: number): number | null {
  const ts = num(cand.dateLastModified) ?? num(cand.dateAdded);
  if (ts === null || ts <= 0) return null;
  return Math.max(0, Math.floor((now - ts) / (24 * 3600 * 1000)));
}

function availableSoon(cand: Record<string, unknown>, now: number): boolean {
  const da = num(cand.dateAvailable);
  if (da === null || da <= 0) return false;
  return da <= now + 30 * 24 * 3600 * 1000; // available now or within 30 days
}

function hasWorkableStatus(cand: Record<string, unknown>): boolean {
  const s = lc(str(cand.status));
  if (!s) return false;
  return WORKABLE_STATUS_HINTS.some((h) => s.includes(h));
}

export function scoreCandidate(
  cand: Record<string, unknown>,
  ctx: RankContext,
  relevanceRank: number,
): RankedCandidate {
  const now = ctx.now ?? Date.now();
  const id = num(cand.id) ?? -1;
  const reasons: string[] = [];

  const mustHits = ctx.mustConcepts
    ? structuredConceptHits(cand, ctx.mustConcepts)
    : structuredSkillHits(cand, ctx.mustTerms);
  const niceHits = structuredSkillHits(cand, ctx.niceTerms ?? []);
  const verified = id >= 0 ? ctx.verifiedTermsById?.get(id) ?? [] : [];
  const local = isLocalMatch(cand, ctx.jobCity, ctx.jobState);
  const rDays = recencyDays(cand, now);
  const availSoon = availableSoon(cand, now);
  const workable = hasWorkableStatus(cand);

  let score = 0;

  if (mustHits.length) {
    score += mustHits.length * W.structuredSkill;
    reasons.push(`skills on file: ${mustHits.join(", ")}`);
  }
  if (verified.length) {
    score += verified.length * W.verifiedSkill;
    reasons.push(`résumé-confirmed: ${verified.join(", ")}`);
  }
  if (niceHits.length) {
    score += niceHits.length * W.niceSkill;
    reasons.push(`bonus: ${niceHits.join(", ")}`);
  }
  if (local) {
    score += W.local;
    reasons.push("local to the role");
  }
  if (availSoon) {
    score += W.availability;
    reasons.push("available now/soon");
  }
  if (workable) {
    score += W.workableStatus;
  }
  if (rDays !== null) {
    if (rDays <= 30) {
      score += W.recencyRecent;
      reasons.push("active in last 30 days");
    } else if (rDays <= 90) {
      score += W.recencyWarm;
      reasons.push("active in last 90 days");
    } else if (rDays <= 180) {
      score += W.recencyMild;
    }
  }

  // Tiny decaying credit for Bullhorn's own relevance order, as a soft tiebreak
  // that never overrides a real recruiter signal.
  score += Math.max(0, 2 - relevanceRank * 0.05);

  return {
    candidate: cand,
    id,
    score: Number(score.toFixed(3)),
    reasons,
    signals: {
      structuredSkillHits: mustHits,
      verifiedSkillHits: verified,
      niceHits,
      isLocal: local,
      recencyDays: rDays,
      availableSoon: availSoon,
      workableStatus: workable,
    },
  };
}

/** Score and order a pool; preserves Bullhorn relevance order as the final tiebreak. */
export function rankCandidates(
  pool: Array<Record<string, unknown>>,
  ctx: RankContext,
): RankedCandidate[] {
  const scored = pool.map((c, idx) => ({ ranked: scoreCandidate(c, ctx, idx), idx }));
  scored.sort((a, b) => {
    if (b.ranked.score !== a.ranked.score) return b.ranked.score - a.ranked.score;
    return a.idx - b.idx;
  });
  return scored.map((s) => s.ranked);
}
