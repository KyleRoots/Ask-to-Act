/**
 * Recency of *relevant* work — a ranking boost, never a filter.
 *
 * Recruiters want people doing this kind of work now (or recently) above people
 * whose only evidence is an old skill list. Older relevant careers stay in the
 * pool; they are not marked unqualified. Missing dates are neutral, not stale.
 *
 * Skill-list / résumé keywords are deliberately ignored here — those already
 * score as structured/verified skill hits. This module only reads occupation
 * and dated work-history titles.
 */
import { asArray, num, recordOf, str } from "./record-utils.js";
import type { Concept } from "./search-taxonomy.js";

export type RelevantRecencyBand =
  | "current"
  | "recent_3y"
  | "recent_7y"
  | "older"
  | "unknown";

export interface RelevantRecency {
  band: RelevantRecencyBand;
  hits: string[];
  evidence: string | null;
  source: "current_role" | "recent_role" | "occupation" | "none";
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
const RECENT_3Y_MS = 3 * MS_PER_YEAR;
const RECENT_7Y_MS = 7 * MS_PER_YEAR;

const BAND_RANK: Record<RelevantRecencyBand, number> = {
  current: 4,
  recent_3y: 3,
  recent_7y: 2,
  older: 1,
  unknown: 0,
};

/** Title noise — too generic to prove the person is in this discipline. */
const ROLE_STOP = new Set([
  "and",
  "the",
  "with",
  "from",
  "for",
  "year",
  "years",
  "yrs",
  "experience",
  "including",
  "related",
  "senior",
  "staff",
  "lead",
  "principal",
  "engineer",
  "specialist",
  "manager",
  "developer",
  "consultant",
  "analyst",
  "director",
  "officer",
  "head",
  "chief",
]);

function lc(s: string): string {
  return s.trim().toLowerCase();
}

function tokensFromConcepts(concepts: Concept[]): Map<string, string[]> {
  /** token/phrase → canonical labels that it supports */
  const byNeedle = new Map<string, string[]>();
  const add = (needle: string, canonical: string) => {
    const key = lc(needle);
    if (!key) return;
    const cur = byNeedle.get(key) ?? [];
    if (!cur.includes(canonical)) cur.push(canonical);
    byNeedle.set(key, cur);
  };
  for (const c of concepts) {
    for (const term of c.terms) {
      const phrase = lc(term);
      if (phrase.length > 1) add(phrase, c.canonical);
      for (const raw of phrase.split(/[^a-z0-9+.#]+/i)) {
        const tok = raw.toLowerCase();
        if (!tok || ROLE_STOP.has(tok)) continue;
        if (tok.length >= 5) add(tok, c.canonical);
        else if (tok.length >= 3 && phrase === tok) add(tok, c.canonical);
      }
    }
  }
  return byNeedle;
}

/** Which required concepts appear in a role title / occupation blob. */
export function roleTextHitsConcepts(text: string, concepts: Concept[]): string[] {
  const blob = lc(text);
  if (!blob || concepts.length === 0) return [];
  const hits = new Set<string>();
  const needles = tokensFromConcepts(concepts);
  for (const [needle, labels] of needles) {
    if (blob.includes(needle)) {
      for (const label of labels) hits.add(label);
    }
  }
  return [...hits];
}

function roleTiming(
  history: Record<string, unknown>,
  now: number,
): { current: boolean; end: number } | null {
  const start = num(history.startDate);
  const rawEnd = num(history.endDate);
  const endMissing = rawEnd === null || rawEnd <= 0;
  const inverted = start !== null && rawEnd !== null && rawEnd > 0 && rawEnd < start;
  const isCurrent = endMissing || (rawEnd !== null && rawEnd > now) || inverted;
  if (start === null && endMissing) return null;
  const end = isCurrent ? now : (rawEnd as number);
  return { current: isCurrent, end };
}

function bandForEnd(current: boolean, end: number, now: number): RelevantRecencyBand {
  if (current) return "current";
  const ago = now - end;
  if (ago <= RECENT_3Y_MS) return "recent_3y";
  if (ago <= RECENT_7Y_MS) return "recent_7y";
  return "older";
}

function better(
  a: { band: RelevantRecencyBand; hits: string[]; evidence: string; source: RelevantRecency["source"] },
  b: { band: RelevantRecencyBand; hits: string[]; evidence: string; source: RelevantRecency["source"] },
) {
  return BAND_RANK[a.band] >= BAND_RANK[b.band] ? a : b;
}

function titleIsGeneric(title: string): boolean {
  const words = lc(title)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.length === 0 || words.every((w) => ROLE_STOP.has(w) || w.length <= 2);
}

/**
 * Copy occupation + workHistories from a getCandidate payload onto a search hit
 * without wiping search-only fields when the entity fetch is sparse.
 */
export function overlayWorkHistory(
  searchHit: Record<string, unknown>,
  full: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!full) return searchHit;
  const occupation = str(full.occupation) || str(searchHit.occupation);
  const histories = asArray(full.workHistories);
  return {
    ...searchHit,
    occupation,
    workHistories: histories.length > 0 ? full.workHistories : searchHit.workHistories,
  };
}

export function assessRelevantRecency(
  candidate: Record<string, unknown>,
  concepts: Concept[],
  now: number = Date.now(),
): RelevantRecency {
  if (concepts.length === 0) {
    return { band: "unknown", hits: [], evidence: null, source: "none" };
  }

  const histories = asArray(candidate.workHistories).map(recordOf);
  let datedRoles = 0;
  let currentRoleGeneric = false;
  let best: {
    band: RelevantRecencyBand;
    hits: string[];
    evidence: string;
    source: RelevantRecency["source"];
  } | null = null;

  for (const h of histories) {
    const timing = roleTiming(h, now);
    if (!timing) continue;
    datedRoles++;
    const title = str(h.title);
    if (timing.current && titleIsGeneric(title)) currentRoleGeneric = true;
    const blob = [title, str(h.companyName)].filter(Boolean).join(" at ");
    const hits = roleTextHitsConcepts(blob, concepts);
    if (hits.length === 0) continue;
    const band = bandForEnd(timing.current, timing.end, now);
    const source: RelevantRecency["source"] = band === "current" ? "current_role" : "recent_role";
    const next = { band, hits, evidence: blob, source };
    best = best ? better(best, next) : next;
  }

  const occupation = str(candidate.occupation);
  const occHits = roleTextHitsConcepts(occupation, concepts);
  if (occHits.length > 0) {
    const occupationCanStandIn = datedRoles === 0 || currentRoleGeneric;
    if (occupationCanStandIn && (!best || BAND_RANK[best.band] < BAND_RANK.current)) {
      const occ = {
        band: "current" as const,
        hits: occHits,
        evidence: occupation,
        source: "occupation" as const,
      };
      best = best ? better(best, occ) : occ;
    }
  }

  if (!best) {
    return { band: "unknown", hits: [], evidence: null, source: "none" };
  }
  return best;
}

export const RELEVANT_RECENCY_WEIGHTS = {
  current: 10,
  recent_3y: 7,
  recent_7y: 3,
  older: 0,
  unknown: 0,
} as const;

export function relevantRecencyPoints(band: RelevantRecencyBand): number {
  return RELEVANT_RECENCY_WEIGHTS[band];
}

export function relevantRecencyReason(fit: RelevantRecency): string | null {
  if (fit.band === "current") {
    return fit.source === "occupation"
      ? `occupation matches current work: ${fit.hits.join(", ")}`
      : `current role matches: ${fit.hits.join(", ")}`;
  }
  if (fit.band === "recent_3y") {
    return `relevant work in last 3 years: ${fit.hits.join(", ")}`;
  }
  if (fit.band === "recent_7y") {
    return `relevant work in last 7 years: ${fit.hits.join(", ")}`;
  }
  return null;
}
