/**
 * Maps a file name / description / optional explicit category onto a Bullhorn
 * Candidate Files-tab "File Type" value (query `type=` on PUT file/.../raw).
 *
 * Query `fileType` must remain SAMPLE; this module only resolves the category.
 */

/** Myticas-like default File Type dropdown (used when firm options are unknown). */
export const DEFAULT_CANDIDATE_FILE_TYPES = [
  "Resume",
  "Formatted Resume",
  "Screening",
  "Onboarding",
  "Training",
  "Payroll/HR",
  "I-9",
  "Unemployment",
  "Other",
] as const;

/**
 * Hint rules — first matching pattern wins. Each rule lists preferred categories
 * in order; the first that exists (or closest-matches) in available options is used.
 */
const HINT_RULES: ReadonlyArray<{ pattern: RegExp; prefer: readonly string[] }> = [
  { pattern: /\bi[\s_-]?9(?:[\W_]|$)/i, prefer: ["I-9"] },
  { pattern: /\bunemployment\b/i, prefer: ["Unemployment"] },
  {
    pattern: /\b(payroll|human[\s_-]?resources?\b|\bhr\b)/i,
    prefer: ["Payroll/HR"],
  },
  { pattern: /\bonboard/i, prefer: ["Onboarding"] },
  {
    pattern: /\b(train(ing|ed|er)?s?\b|certificat(e|ion)?s?)\b/i,
    prefer: ["Training"],
  },
  {
    // Security briefing / clearance / background / drug screen → Screening
    pattern:
      /\b(security([\s_-]+briefing)?|briefing([\s_-]+form)?|clearance|screen(ing)?|background([\s_-]+check)?|drug[\s_-]?screen|nda|non[\s_-]?disclosure)\b/i,
    prefer: ["Screening"],
  },
  {
    pattern: /\bformatted[\s_-]?resume\b|\bresume[\s_-]?formatted\b/i,
    prefer: ["Formatted Resume", "Resume"],
  },
  {
    pattern: /\b(resume|curriculum[\s_-]?vitae|\bcv\b)\b/i,
    prefer: ["Resume"],
  },
  {
    pattern: /\bcover[\s_-]?letter\b/i,
    prefer: ["Other"],
  },
];

function normalizeKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(s: string): string[] {
  return normalizeKey(s).split(" ").filter(Boolean);
}

/** True when tokens share a meaningful stem (screen≈screening, resume≈resumes). */
function tokensRelated(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Score how well `needle` matches an option label. Higher is better.
 * Exact / contained matches beat fuzzy token overlap.
 */
function matchScore(needle: string, option: string): number {
  const n = normalizeKey(needle);
  const o = normalizeKey(option);
  if (!n || !o) return 0;
  if (n === o) return 1000;
  if (o.includes(n) || n.includes(o)) return 800 + Math.min(n.length, o.length);
  const nTok = tokens(needle);
  const oTok = tokens(option);
  if (nTok.length === 0 || oTok.length === 0) return 0;
  let overlap = 0;
  for (const ot of oTok) {
    if (nTok.some((nt) => tokensRelated(nt, ot))) overlap += 1;
  }
  if (overlap === 0) return 0;
  return overlap * 50 + overlap / Math.max(nTok.length, oTok.length);
}

/** Closest option to `needle`, or null when nothing scores. */
export function closestFileTypeOption(
  needle: string,
  availableTypes: readonly string[],
  minScore = 50,
): string | null {
  const trimmed = needle.trim();
  if (!trimmed || availableTypes.length === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const opt of availableTypes) {
    const score = matchScore(trimmed, opt);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  return bestScore >= minScore ? best : null;
}

export type ResolveBullhornFileTypeArgs = {
  fileName?: string | null;
  description?: string | null;
  /** Explicit tool/user category — wins when provided (then closest-matched). */
  fileType?: string | null;
  /** Firm File Type dropdown values when known; defaults to Myticas-like list. */
  availableTypes?: readonly string[] | null;
};

/**
 * Resolve the Bullhorn Files-tab category (`type=` query param).
 * Returns null only when there is nothing to send (empty options + no signal).
 */
export function resolveBullhornFileType(
  args: ResolveBullhornFileTypeArgs,
): string | null {
  const available =
    args.availableTypes && args.availableTypes.length > 0
      ? [...args.availableTypes]
      : [...DEFAULT_CANDIDATE_FILE_TYPES];

  const explicit = args.fileType?.trim();
  if (explicit) {
    // Explicit wins: prefer exact/closest option; otherwise pass through as-is
    // so firms with custom types still work when discovery missed them.
    return closestFileTypeOption(explicit, available, 1) ?? explicit;
  }

  const haystackRaw = `${args.fileName ?? ""} ${args.description ?? ""}`.trim();
  if (!haystackRaw) {
    return closestFileTypeOption("Other", available, 1) ?? available[0] ?? null;
  }
  // Underscores/hyphens in filenames become spaces so `\bsecurity\b` etc. match.
  const haystack = `${haystackRaw} ${normalizeKey(haystackRaw)}`;

  for (const rule of HINT_RULES) {
    if (!rule.pattern.test(haystack)) continue;
    for (const prefer of rule.prefer) {
      const hit = closestFileTypeOption(prefer, available, 1);
      if (hit) return hit;
    }
  }

  // Last resort: fuzzy the original haystack against options, else Other.
  const fuzzy = closestFileTypeOption(haystackRaw, available, 100);
  if (fuzzy) return fuzzy;
  return closestFileTypeOption("Other", available, 1) ?? available[0] ?? null;
}
