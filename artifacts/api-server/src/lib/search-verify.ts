/**
 * Precision layer — shortlist fact-checking.
 *
 * Bullhorn keyword matching is relevance-ranked, NOT strict, so a top hit can lack a
 * must-have term entirely. Rather than trust the search, we confirm the required
 * terms against each shortlisted candidate's actual résumé (VERIFY mode returns a
 * short quote per matched term). Results carry which terms were confirmed vs missing
 * so callers can either present evidence-backed claims or hard-drop unconfirmed
 * candidates. Generalized from the matcher so search and matching share one path.
 */

import { getCandidateResume } from "./bullhorn-client.js";
import { mapLimit } from "./record-utils.js";
import type { Concept } from "./search-taxonomy.js";

export interface VerifyResult {
  matchedTerms: string[];
  missingTerms: string[];
  excerpts: Array<{ term: string; text: string }>;
}

export interface ConceptVerifyResult {
  /** Canonical labels of concepts whose résumé confirmed at least one synonym. */
  matchedConcepts: string[];
  /** Canonical labels of concepts not found anywhere in the résumé. */
  missingConcepts: string[];
  /** The raw synonym terms that actually matched (for transparency). */
  matchedTerms: string[];
  /** Skill evidence only — probe phrases are stripped out of each `terms` list. */
  excerpts: Array<{ terms: string[]; quote: string }>;
  /**
   * Quotes triggered by non-skill probe terms (e.g. "years of experience"), kept
   * apart so they can never be cited as proof of a skill. Overlapping windows that
   * also contain a skill stay in `excerpts` with the probe term removed from
   * `terms`; their quote text is still available for experience parsing.
   */
  probeExcerpts: Array<{ terms: string[]; quote: string }>;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_EXCERPTS = 3;

/**
 * Confirm `terms` against each candidate's résumé. Returns a map keyed by candidate
 * id. A résumé fetch failure is treated as "nothing confirmed" (fails OPEN for the
 * data, CLOSED for the claim) so a transient error never fabricates evidence.
 */
export async function verifyCandidates(
  ids: number[],
  terms: string[],
  opts: { concurrency?: number } = {},
): Promise<Map<number, VerifyResult>> {
  const out = new Map<number, VerifyResult>();
  if (terms.length === 0) {
    for (const id of ids) out.set(id, { matchedTerms: [], missingTerms: [], excerpts: [] });
    return out;
  }

  const results = await mapLimit(ids, opts.concurrency ?? DEFAULT_CONCURRENCY, async (id) => {
    try {
      const r = (await getCandidateResume({ candidateId: id, highlight: terms })) as {
        matchedTerms?: string[];
        excerpts?: Array<{ term: string; text: string }>;
      };
      const matched = r.matchedTerms ?? [];
      const matchedSet = new Set(matched.map((t) => t.toLowerCase()));
      const missing = terms.filter((t) => !matchedSet.has(t.toLowerCase()));
      return {
        id,
        res: { matchedTerms: matched, missingTerms: missing, excerpts: (r.excerpts ?? []).slice(0, MAX_EXCERPTS) },
      };
    } catch {
      return { id, res: { matchedTerms: [], missingTerms: [...terms], excerpts: [] } };
    }
  });

  for (const { id, res } of results) out.set(id, res);
  return out;
}

/**
 * Of the supplied ids, those whose résumé confirmed at least one of `requiredTerms`.
 * Used to hard-drop candidates a non-strict search surfaced that don't actually
 * mention any required term anywhere.
 */
export function confirmedIds(
  verified: Map<number, VerifyResult>,
  requiredTerms: string[],
): Set<number> {
  const req = new Set(requiredTerms.map((t) => t.toLowerCase()));
  const keep = new Set<number>();
  for (const [id, v] of verified) {
    if (req.size === 0) {
      keep.add(id);
      continue;
    }
    if (v.matchedTerms.some((t) => req.has(t.toLowerCase()))) keep.add(id);
  }
  return keep;
}

/**
 * Concept-aware verification: confirm CONCEPTS (canonical + synonyms) against each
 * résumé. A concept counts as confirmed if ANY of its synonyms appears, so a query
 * for "AWS" is satisfied by a résumé that only says "Amazon Web Services". All
 * synonyms are highlighted in one call per candidate; results are mapped back to the
 * canonical concept labels. A fetch failure fails CLOSED (nothing confirmed).
 */
export async function verifyConcepts(
  ids: number[],
  concepts: Concept[],
  opts: { concurrency?: number; probeTerms?: readonly string[] } = {},
): Promise<Map<number, ConceptVerifyResult>> {
  const out = new Map<number, ConceptVerifyResult>();
  const probeTerms = [...new Set(opts.probeTerms ?? [])];
  const probeSet = new Set(probeTerms.map((t) => t.toLowerCase()));
  if (concepts.length === 0 && probeTerms.length === 0) {
    for (const id of ids) {
      out.set(id, {
        matchedConcepts: [],
        missingConcepts: [],
        matchedTerms: [],
        excerpts: [],
        probeExcerpts: [],
      });
    }
    return out;
  }

  // One highlight call per candidate across the union of all synonyms plus any probes,
  // so probe terms never cost an extra résumé fetch.
  const highlight = [...new Set([...concepts.flatMap((c) => c.terms), ...probeTerms])];

  const results = await mapLimit(ids, opts.concurrency ?? DEFAULT_CONCURRENCY, async (id) => {
    try {
      const r = (await getCandidateResume({ candidateId: id, highlight })) as {
        matchedTerms?: string[];
        excerpts?: Array<{ terms?: string[]; quote?: string; term?: string; text?: string }>;
      };
      const allMatched = r.matchedTerms ?? [];
      // Probe hits are not skills — keep them out of matchedTerms so no concept can be
      // satisfied by, or evidenced with, an experience phrase.
      const matchedTerms = allMatched.filter((t) => !probeSet.has(t.toLowerCase()));
      const matchedSet = new Set(matchedTerms.map((t) => t.toLowerCase()));
      const matchedConcepts: string[] = [];
      const missingConcepts: string[] = [];
      for (const c of concepts) {
        const hit = c.terms.some((t) => matchedSet.has(t.toLowerCase()));
        (hit ? matchedConcepts : missingConcepts).push(c.canonical);
      }

      // getCandidateResume emits { terms, quote }; older mocks used { term, text }.
      const normalize = (
        e: { terms?: string[]; quote?: string; term?: string; text?: string },
      ): { terms: string[]; quote: string } => {
        const terms =
          Array.isArray(e.terms) && e.terms.length > 0
            ? e.terms
            : typeof e.term === "string" && e.term
              ? [e.term]
              : [];
        const quote =
          (typeof e.quote === "string" && e.quote) ||
          (typeof e.text === "string" && e.text) ||
          "";
        return { terms, quote };
      };

      const skillExcerpts: Array<{ terms: string[]; quote: string }> = [];
      const probeExcerpts: Array<{ terms: string[]; quote: string }> = [];
      for (const raw of r.excerpts ?? []) {
        const e = normalize(raw);
        if (!e.quote) continue;
        const skillTerms = e.terms.filter((t) => !probeSet.has(t.toLowerCase()));
        const probeTermsOnly = e.terms.filter((t) => probeSet.has(t.toLowerCase()));
        if (skillTerms.length > 0) {
          skillExcerpts.push({ terms: skillTerms, quote: e.quote });
        }
        if (probeTermsOnly.length > 0) {
          probeExcerpts.push({ terms: probeTermsOnly, quote: e.quote });
        }
      }

      return {
        id,
        res: {
          matchedConcepts,
          missingConcepts,
          matchedTerms,
          excerpts: skillExcerpts.slice(0, MAX_EXCERPTS),
          probeExcerpts: probeExcerpts.slice(0, MAX_EXCERPTS),
        },
      };
    } catch {
      return {
        id,
        res: {
          matchedConcepts: [],
          missingConcepts: concepts.map((c) => c.canonical),
          matchedTerms: [],
          excerpts: [],
          probeExcerpts: [],
        },
      };
    }
  });

  for (const { id, res } of results) out.set(id, res);
  return out;
}

/**
 * Of the supplied ids, those whose résumé confirmed at least one required CONCEPT.
 * Used to hard-drop candidates a non-strict search surfaced that don't actually
 * mention any required concept (via any synonym) anywhere in their résumé.
 */
export function confirmedConceptIds(verified: Map<number, ConceptVerifyResult>): Set<number> {
  const keep = new Set<number>();
  for (const [id, v] of verified) {
    if (v.matchedConcepts.length > 0) keep.add(id);
  }
  return keep;
}
