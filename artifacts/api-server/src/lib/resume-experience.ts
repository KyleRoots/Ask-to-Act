/**
 * Résumé-stated years of experience.
 *
 * `workHistories` (see candidate-experience.ts) is Bullhorn's PARSE of the résumé and
 * is frequently wrong on this instance — real senior people come back as "0.9 years,
 * junior", and degree lines get stored as employers. Résumés themselves usually state
 * total experience in prose ("Over 8+ years of professional experience").
 *
 * These probe terms ride along on the résumé fetch the matcher already performs for
 * skill verification, so reading them costs no extra Bullhorn calls.
 */

export interface ResumeYears {
  years: number;
  /** The quote the number came from, so the claim stays citable. */
  evidence: string;
}

/** Phrases highlighted alongside skill terms to surface experience statements. */
export const RESUME_EXPERIENCE_PROBE_TERMS = [
  "years of experience",
  "years experience",
  "years of professional experience",
  "years professional experience",
  "years of industry experience",
  "total years experience",
  "yrs of experience",
  "yrs experience",
] as const;

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, twentyfive: 25, thirty: 30,
};

/** Beyond this we assume a mis-parse (e.g. a year like "2015 years") rather than tenure. */
const MAX_PLAUSIBLE_YEARS = 55;

// The leading \b stops a four-digit year ("2015 years") from matching as "15".
const DIGIT_PATTERN =
  /\b(\d{1,2})(?:\.\d)?\s*\+?\s*(?:year|yr)s?\b/gi;
const WORD_PATTERN = new RegExp(
  `\\b(${Object.keys(WORD_NUMBERS).join("|")})\\s+(?:year|yr)s?\\b`,
  "gi",
);

/**
 * Largest plausible "N years" claim across the supplied excerpts.
 *
 * Résumés often list per-skill tenure ("9 years of HTML, 2 years of SCSS") alongside a
 * career total, so the maximum is the best single estimate of overall experience. It can
 * still understate someone whose résumé never states a total — callers treat this as
 * corroborating evidence, never as an authoritative figure on its own.
 *
 * Accepts both getCandidateResume's `{ terms, quote }` shape and older `{ term, text }`
 * mocks. Whitespace inside quotes is collapsed so a résumé that wraps mid-phrase
 * ("Total years\nexperience: 30") still parses.
 */
export function parseResumeYears(
  excerpts:
    | Array<{ term?: string; text?: string; terms?: string[]; quote?: string }>
    | undefined,
): ResumeYears | null {
  if (!excerpts || excerpts.length === 0) return null;

  let best: ResumeYears | null = null;
  const consider = (value: number, text: string) => {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_PLAUSIBLE_YEARS) return;
    if (best === null || value > best.years) {
      best = { years: value, evidence: text.trim().slice(0, 240) };
    }
  };

  for (const excerpt of excerpts) {
    const raw =
      (typeof excerpt?.quote === "string" && excerpt.quote) ||
      (typeof excerpt?.text === "string" && excerpt.text) ||
      "";
    if (!raw) continue;
    const text = raw.replace(/\s+/g, " ");
    for (const m of text.matchAll(DIGIT_PATTERN)) {
      consider(Number(m[1]), text);
    }
    for (const m of text.matchAll(WORD_PATTERN)) {
      consider(WORD_NUMBERS[m[1].toLowerCase()] ?? 0, text);
    }
  }

  return best;
}

export type ExperienceAgreement = "resume_only" | "history_only" | "agree" | "conflict";

export interface ReconciledExperience {
  /** Best single estimate, or null when nothing is derivable. */
  years: number | null;
  agreement: ExperienceAgreement | "none";
  resumeYears: number | null;
  historyYears: number | null;
  evidence: string | null;
}

/** Absolute and relative slack before two estimates are called contradictory. */
const AGREEMENT_ABSOLUTE_YEARS = 3;
const AGREEMENT_RELATIVE = 0.4;

/**
 * Combine the résumé claim with Bullhorn's work-history math.
 *
 * When the two broadly agree we report the higher figure with confidence. When they
 * contradict each other we say so rather than picking a winner — the matcher then treats
 * the experience criterion as unverified instead of confidently passing or failing
 * someone on a number we know is disputed.
 */
export function reconcileExperience(
  resumeYears: number | null,
  historyYears: number | null,
  evidence: string | null = null,
): ReconciledExperience {
  if (resumeYears === null && historyYears === null) {
    return { years: null, agreement: "none", resumeYears, historyYears, evidence: null };
  }
  if (resumeYears === null) {
    return {
      years: historyYears,
      agreement: "history_only",
      resumeYears,
      historyYears,
      evidence: null,
    };
  }
  if (historyYears === null) {
    return { years: resumeYears, agreement: "resume_only", resumeYears, historyYears, evidence };
  }

  const spread = Math.abs(resumeYears - historyYears);
  const tolerance = Math.max(
    AGREEMENT_ABSOLUTE_YEARS,
    Math.max(resumeYears, historyYears) * AGREEMENT_RELATIVE,
  );
  const agreement: ExperienceAgreement = spread <= tolerance ? "agree" : "conflict";
  return {
    years: Math.max(resumeYears, historyYears),
    agreement,
    resumeYears,
    historyYears,
    evidence,
  };
}
