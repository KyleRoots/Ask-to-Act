/**
 * Experience & recency derivation.
 *
 * Bullhorn's structured `experience` (years) field is almost always empty in this
 * tenant, so any "5+ years" or seniority filter applied to it silently fails. The
 * reliable signal is the candidate's WORK HISTORY dates. We derive years, seniority,
 * and recency from those so search/matching can rank and qualify on real tenure.
 */

import { asArray, num, recordOf, str } from "./record-utils.js";

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
const MS_PER_MONTH = MS_PER_YEAR / 12;

export type Seniority = "unknown" | "junior" | "mid" | "senior" | "lead";

export interface ExperienceSummary {
  /** Total years worked, merging overlapping roles so concurrent jobs aren't double-counted. */
  yearsExperience: number | null;
  /** Earliest start → latest end (or now): the career span, gaps included. */
  careerSpanYears: number | null;
  roleCount: number;
  currentRole: { title: string; company: string } | null;
  /** Months since the most recent role ended (0 if currently employed). */
  lastActivityMonthsAgo: number | null;
  seniority: Seniority;
  basis: string;
}

function bandFor(years: number | null): Seniority {
  if (years === null) return "unknown";
  if (years >= 10) return "lead";
  if (years >= 6) return "senior";
  if (years >= 3) return "mid";
  if (years > 0) return "junior";
  return "unknown";
}

export function deriveExperience(candidate: unknown, now: number = Date.now()): ExperienceSummary {
  const c = recordOf(candidate);
  const histories = asArray(c.workHistories).map(recordOf);

  const intervals: Array<[number, number]> = [];
  let current: { title: string; company: string } | null = null;
  let latestEnd = 0;

  for (const h of histories) {
    const start = num(h.startDate);
    if (start === null || start <= 0) continue;
    const rawEnd = num(h.endDate);
    // A missing/zero/future end date (or an end before the start) means "current".
    const isCurrent = rawEnd === null || rawEnd <= 0 || rawEnd > now || rawEnd < start;
    const effEnd = isCurrent ? now : (rawEnd as number);
    if (isCurrent && !current) {
      current = { title: str(h.title), company: str(h.companyName) };
    }
    if (effEnd > latestEnd) latestEnd = effEnd;
    if (effEnd > start) intervals.push([start, effEnd]);
  }

  if (intervals.length === 0) {
    return {
      yearsExperience: null,
      careerSpanYears: null,
      roleCount: histories.length,
      currentRole: current,
      lastActivityMonthsAgo: null,
      seniority: "unknown",
      basis: "no dated work history",
    };
  }

  // Merge overlapping intervals before summing so concurrent roles count once.
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) {
      last[1] = Math.max(last[1], iv[1]);
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }

  const totalMs = merged.reduce((s, [a, b]) => s + (b - a), 0);
  const earliest = merged[0][0];
  const years = Number((totalMs / MS_PER_YEAR).toFixed(1));
  const spanYears = Number(((latestEnd - earliest) / MS_PER_YEAR).toFixed(1));
  const lastActivityMonthsAgo = current
    ? 0
    : Math.max(0, Math.round((now - latestEnd) / MS_PER_MONTH));

  return {
    yearsExperience: years,
    careerSpanYears: spanYears,
    roleCount: histories.length,
    currentRole: current,
    lastActivityMonthsAgo,
    seniority: bandFor(years),
    basis: `${merged.length} dated role interval(s)`,
  };
}
