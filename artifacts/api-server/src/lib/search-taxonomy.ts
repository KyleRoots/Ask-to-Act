/**
 * Search recall layer — server-side concept expansion.
 *
 * The single biggest variable in candidate-search recall is whether the *caller*
 * remembers to expand a concept into its synonyms ("React" → "React.js" / "ReactJS",
 * "TS/SCI" → its clearance variants). When the AI forgets, qualified people are
 * silently missed. We move that expansion onto the server so recall is consistent
 * regardless of which model is driving and at zero per-call LLM cost.
 *
 * `expandConcept` turns one required concept into a deduped OR-group of equivalent
 * phrases (curated synonyms + orthographic variants). Downstream this becomes a
 * single Lucene synonym group, so it widens recall WITHOUT loosening the AND between
 * distinct must-have concepts.
 *
 * Design guardrails:
 *  - High precision over coverage: only add synonyms we are confident are equivalent
 *    in a recruiting context. A wrong synonym pollutes results worse than a miss.
 *  - No ambiguous abbreviation expansion. "TS" means Top Secret AND TypeScript; we
 *    therefore never expand a bare "TS" — only the unambiguous direction
 *    (TypeScript → "TS") so a TypeScript search still catches "TS" résumés, while a
 *    clearance search for "TS" is never polluted with TypeScript hits.
 */

const MAX_EXPANSIONS = 8;

/**
 * Curated mutually-synonymous groups. Every term in a group is treated as
 * equivalent to every other term in that group. Keep entries lowercase; matching
 * is case-insensitive. Order within a group is irrelevant.
 *
 * NOTE: do NOT add ambiguous short tokens here (e.g. bare "ts", "pm", "ml" as the
 * lookup key) — see `AMBIGUOUS_KEYS` and the directional entries below.
 */
const SYNONYM_GROUPS: string[][] = [
  // ---- Security clearances (US) ----
  ["top secret", "ts clearance", "ts/sci", "ts sci", "sci clearance"],
  ["secret clearance", "secret security clearance"],
  ["public trust", "public trust clearance"],
  // ---- Security clearances (Canada) ----
  ["reliability status", "reliability clearance"],
  ["enhanced reliability", "enhanced reliability status"],
  ["secret clearance canada", "level ii clearance"],
  ["top secret canada", "level iii clearance"],
  // ---- Languages / runtimes ----
  ["javascript", "java script", "ecmascript"],
  ["typescript", "type script", "ts"], // directional: TypeScript→ts, never ts→TypeScript
  ["c sharp", "c#", "csharp", "dotnet", ".net"],
  ["c plus plus", "c++", "cpp"],
  ["golang", "go lang"],
  ["python", "py"],
  // ---- Frameworks / libraries ----
  ["react", "react.js", "reactjs", "react js"],
  ["angular", "angular.js", "angularjs", "angular js"],
  ["vue", "vue.js", "vuejs", "vue js"],
  ["node", "node.js", "nodejs", "node js"],
  ["next.js", "nextjs", "next js"],
  ["spring boot", "springboot"],
  ["dot net core", ".net core", "asp.net", "asp net"],
  // ---- Cloud / infra ----
  ["aws", "amazon web services"],
  ["gcp", "google cloud", "google cloud platform"],
  ["azure", "microsoft azure"],
  ["kubernetes", "k8s", "kube"],
  ["terraform", "iac", "infrastructure as code"],
  ["ci/cd", "ci cd", "cicd", "continuous integration"],
  // ---- Roles / disciplines ----
  ["devops", "dev ops", "site reliability", "sre"],
  ["full stack", "fullstack", "full-stack"],
  ["front end", "frontend", "front-end"],
  ["back end", "backend", "back-end"],
  ["quality assurance", "qa", "quality assurance engineer"],
  [
    "sdet",
    "software development engineer in test",
    "test automation engineer",
    "qa automation engineer",
    "automation tester",
    "test developer",
  ],
  ["business analyst", "ba analyst", "business systems analyst"],
  ["machine learning", "ml engineer", "machine learning engineer"],
  ["artificial intelligence", "ai engineer"],
  ["registered nurse", "rn nurse"],
  ["project manager", "project management", "pmp"],
  ["product manager", "product management", "product owner"],
  ["data engineer", "data engineering"],
  ["data scientist", "data science"],
];

/**
 * Lookup keys that are too ambiguous to expand FROM, even though they may appear
 * as a synonym TARGET above. If a caller's concept (normalized) is exactly one of
 * these, we return it unchanged plus only orthographic variants — never the
 * curated group — so e.g. a clearance search for "TS" is not polluted with
 * TypeScript, and "PM"/"ML"/"BA"/"RN"/"go"/"py" don't over-expand.
 */
const AMBIGUOUS_KEYS = new Set([
  "ts",
  "pm",
  "ml",
  "ai",
  "ba",
  "rn",
  "go",
  "py",
  "qa",
  "sci",
  "sre",
  "ci",
  "cd",
  "iac",
]);

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// Index: normalized term -> set of all terms sharing any of its groups.
const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
  const idx = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const key = norm(term);
      let bucket = idx.get(key);
      if (!bucket) {
        bucket = new Set<string>();
        idx.set(key, bucket);
      }
      for (const other of group) bucket.add(norm(other));
    }
  }
  return idx;
})();

/**
 * Generate orthographic variants for a term by toggling the separators between the
 * "core" and a trailing tech suffix (js / .js), and by normalizing internal
 * separators. Bounded and conservative — only patterns that are genuinely the same
 * token written differently.
 */
function orthographicVariants(term: string): string[] {
  const t = norm(term);
  const out = new Set<string>([t]);

  // Internal separator normalization: "front-end" <-> "front end" <-> "frontend".
  if (/[ \-]/.test(t)) {
    out.add(t.replace(/[ \-]+/g, " "));
    out.add(t.replace(/[ \-]+/g, "-"));
    out.add(t.replace(/[ \-]+/g, ""));
  }

  // Trailing "js" / ".js" / " js" family: react / react.js / reactjs / react js.
  const jsMatch = t.match(/^(.*?)[ .]?js$/);
  if (jsMatch && jsMatch[1] && jsMatch[1].length >= 2) {
    const core = jsMatch[1].trim();
    out.add(core);
    out.add(`${core}.js`);
    out.add(`${core}js`);
    out.add(`${core} js`);
  }

  // Trailing ".net" family.
  if (/\.net$/.test(t)) {
    const core = t.replace(/\.net$/, "").trim();
    if (core) {
      out.add(`${core} .net`.trim());
      out.add(`${core}.net`);
    }
  }

  return [...out].filter((v) => v.length > 0);
}

/**
 * Expand one required concept into a deduped list of equivalent phrases (the
 * original first). Result is intended to be passed as a single synonym/OR group.
 */
export function expandConcept(term: string): string[] {
  const original = term.trim();
  if (!original) return [];
  const key = norm(original);

  const result = new Set<string>([original]);

  // Curated synonyms — skipped when the lookup key is ambiguous to expand FROM.
  if (!AMBIGUOUS_KEYS.has(key)) {
    const syn = SYNONYM_INDEX.get(key);
    if (syn) for (const s of syn) result.add(s);
  }

  // Orthographic variants for the original and for each curated synonym so far.
  for (const base of [...result]) {
    for (const v of orthographicVariants(base)) result.add(v);
  }

  // Keep the caller's original casing for the first element; dedupe the rest by
  // normalized form so we don't return "react" and "React" as two clauses.
  const seen = new Set<string>([key]);
  const ordered: string[] = [original];
  for (const v of result) {
    const nv = norm(v);
    if (seen.has(nv)) continue;
    seen.add(nv);
    ordered.push(v);
    if (ordered.length >= MAX_EXPANSIONS) break;
  }
  return ordered;
}

/**
 * Expand a list of required concepts. Each input concept becomes one OR-group
 * (array). Distinct concepts remain separate groups so the caller can AND them.
 */
export function expandConcepts(terms: string[]): string[][] {
  return terms.map((t) => expandConcept(t)).filter((g) => g.length > 0);
}

/**
 * A required concept and ALL its equivalent phrases. Carrying the canonical label
 * alongside its synonyms lets every downstream stage (search, ranking, résumé
 * verification) treat the synonyms as ONE concept — so a candidate matched via a
 * synonym ("Amazon Web Services" for a query of "AWS") is scored and confirmed the
 * same as an exact match, instead of being under-ranked or wrongly dropped.
 */
export interface Concept {
  /** The caller's original term, used as the display/label for this concept. */
  canonical: string;
  /** Canonical + curated synonyms + orthographic variants (the OR-group). */
  terms: string[];
}

/** Build concepts (canonical + expanded synonyms) for a list of required terms. */
export function toConcepts(terms: string[]): Concept[] {
  return terms
    .map((t) => ({ canonical: t.trim(), terms: expandConcept(t) }))
    .filter((c) => c.canonical.length > 0 && c.terms.length > 0);
}
