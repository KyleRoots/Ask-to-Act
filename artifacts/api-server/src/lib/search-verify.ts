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
  excerpts: Array<{ term: string; text: string }>;
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
  opts: { concurrency?: number } = {},
): Promise<Map<number, ConceptVerifyResult>> {
  const out = new Map<number, ConceptVerifyResult>();
  if (concepts.length === 0) {
    for (const id of ids) {
      out.set(id, { matchedConcepts: [], missingConcepts: [], matchedTerms: [], excerpts: [] });
    }
    return out;
  }

  // One highlight call per candidate across the union of all synonyms.
  const highlight = [...new Set(concepts.flatMap((c) => c.terms))];

  const results = await mapLimit(ids, opts.concurrency ?? DEFAULT_CONCURRENCY, async (id) => {
    try {
      const r = (await getCandidateResume({ candidateId: id, highlight })) as {
        matchedTerms?: string[];
        excerpts?: Array<{ term: string; text: string }>;
      };
      const matchedTerms = r.matchedTerms ?? [];
      const matchedSet = new Set(matchedTerms.map((t) => t.toLowerCase()));
      const matchedConcepts: string[] = [];
      const missingConcepts: string[] = [];
      for (const c of concepts) {
        const hit = c.terms.some((t) => matchedSet.has(t.toLowerCase()));
        (hit ? matchedConcepts : missingConcepts).push(c.canonical);
      }
      return {
        id,
        res: {
          matchedConcepts,
          missingConcepts,
          matchedTerms,
          excerpts: (r.excerpts ?? []).slice(0, MAX_EXCERPTS),
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
