/**
 * Structured JobOrder requirement extraction for candidate matching.
 *
 * Structured Bullhorn fields take precedence over description-text heuristics.
 * Every requirement records its source so GPT can explain what was used vs inferred.
 */
import { asArray, num, recordOf, str } from "./record-utils.js";

export type RequirementSource =
  | "structured"
  | "description"
  | "user"
  | "fallback"
  | "unknown";

export type WorkArrangement =
  | "onsite"
  | "hybrid"
  | "remote"
  | "no_preference"
  | "unspecified";

export interface ParsedRequirement {
  key: string;
  label: string;
  value: unknown;
  source: RequirementSource;
  confidence: "high" | "medium" | "low";
  /** Hard eligibility constraint when true; otherwise a ranking preference. */
  hard: boolean;
}

export interface JobCompensation {
  low: number | null;
  high: number | null;
  payRate: number | null;
  unit: string | null;
}

export interface JobRequirements {
  title: string;
  jobCity: string;
  jobState: string;
  locationLabel: string;
  workArrangement: WorkArrangement;
  workArrangementSource: RequirementSource;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  yearsRequired: number | null;
  employmentType: string | null;
  educationDegree: string | null;
  /** null = unset / unknown on the job. */
  willSponsor: boolean | null;
  compensation: JobCompensation;
  parsedRequirements: ParsedRequirement[];
  skillDerivation: "skills" | "skillList" | "user" | "title_fallback";
}

function splitSkills(raw: string): string[] {
  return raw
    .split(/[,;\n|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length <= 40);
}

/** Normalize Bullhorn scalar/array/option quirks into a flat string list. */
export function normalizeStringList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") {
    const t = value.trim();
    return t ? [t] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((v) => normalizeStringList(v));
  }
  if (typeof value === "object") {
    const rec = recordOf(value);
    const named = str(rec.name) || str(rec.label) || str(rec.value);
    return named ? [named] : [];
  }
  return [];
}

function lc(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Map Work Location Requirements / WFH flags / description text into a
 * work-arrangement enum. Structured fields win over description inference.
 */
export function detectWorkArrangement(job: Record<string, unknown>): {
  arrangement: WorkArrangement;
  source: RequirementSource;
  evidence: string;
} {
  const onSiteValues = normalizeStringList(job.onSite).map(lc);
  if (onSiteValues.length > 0) {
    const joined = onSiteValues.join(" | ");
    if (onSiteValues.some((v) => /\bhybrid\b/.test(v))) {
      return { arrangement: "hybrid", source: "structured", evidence: `onSite=${joined}` };
    }
    if (onSiteValues.some((v) => /\bremote\b|\bwfh\b|work from home|off-?site/.test(v))) {
      return { arrangement: "remote", source: "structured", evidence: `onSite=${joined}` };
    }
    if (onSiteValues.some((v) => /no preference|any|flexible/.test(v))) {
      return {
        arrangement: "no_preference",
        source: "structured",
        evidence: `onSite=${joined}`,
      };
    }
    if (onSiteValues.some((v) => /on-?site|in[- ]office|in[- ]person/.test(v))) {
      return { arrangement: "onsite", source: "structured", evidence: `onSite=${joined}` };
    }
  }

  if (job.isWorkFromHome === true) {
    return {
      arrangement: "remote",
      source: "structured",
      evidence: "isWorkFromHome=true",
    };
  }
  if (job.isWorkFromHome === false) {
    // Explicit false without onSite still implies not fully remote — treat as onsite
    // preference unless description clarifies hybrid.
    return {
      arrangement: "onsite",
      source: "structured",
      evidence: "isWorkFromHome=false",
    };
  }

  const description = str(job.publicDescription) || str(job.description);
  if (description) {
    const d = description.toLowerCase();
    if (/\bhybrid\b/.test(d)) {
      return { arrangement: "hybrid", source: "description", evidence: "description:hybrid" };
    }
    if (/\b(on-?site|in[- ]office|in[- ]person)\b/.test(d)) {
      return { arrangement: "onsite", source: "description", evidence: "description:onsite" };
    }
    if (/\b(remote|work from home|wfh|fully remote)\b/.test(d)) {
      return { arrangement: "remote", source: "description", evidence: "description:remote" };
    }
  }

  return { arrangement: "unspecified", source: "unknown", evidence: "no work-arrangement signal" };
}

/** Pull skill names from TO_MANY skills association and/or skillList text. */
export function extractJobSkills(job: Record<string, unknown>): {
  skills: string[];
  source: "skills" | "skillList" | "none";
} {
  const fromAssoc: string[] = [];
  for (const s of asArray(job.skills)) {
    const name = str(recordOf(s).name);
    if (name) fromAssoc.push(name);
  }
  // Sometimes skills arrives as a delimited string in tests / older payloads.
  if (fromAssoc.length === 0 && typeof job.skills === "string") {
    fromAssoc.push(...splitSkills(job.skills));
  }
  if (fromAssoc.length > 0) {
    return { skills: [...new Set(fromAssoc)], source: "skills" };
  }
  const fromList = splitSkills(str(job.skillList));
  if (fromList.length > 0) {
    return { skills: fromList, source: "skillList" };
  }
  return { skills: [], source: "none" };
}

/**
 * Words that appear in job titles but are never a skill to look for in a résumé.
 * Matching a candidate on "PERM" or "Senior" is noise; matching on "SAP" is signal.
 */
const NON_SKILL_TITLE_WORDS = new Set([
  // Employment type / contract vehicle
  "perm", "permanent", "contract", "contractor", "contracts", "temp", "temporary",
  "c2c", "w2", "1099", "fte", "direct", "hire", "hiring", "full", "part", "time",
  // Work arrangement
  "remote", "onsite", "on-site", "hybrid", "wfh", "telecommute", "telework",
  // Seniority / level
  "senior", "junior", "principal", "staff", "entry", "level", "mid",
  "intermediate", "associate", "lead", "head", "chief",
  // Requisition filler
  "position", "positions", "opening", "openings", "role", "job", "req",
  "requisition", "needed", "urgent", "opportunity", "new", "and", "the", "for",
  "with", "our", "team", "bilingual",
]);

/** Job codes such as JPABB-001 or REQ12345 — never résumé evidence. */
function looksLikeJobCode(token: string): boolean {
  if (/^\d+$/.test(token)) return true;
  return /^[a-z]{1,8}[-_]?\d{2,}$/i.test(token);
}

/**
 * Last-resort skill guess when a job record has no skills filled in.
 *
 * Parenthesised fragments ("(JPABB-001)", "(Ottawa)") are dropped wholesale, then
 * employment/seniority filler, job codes, and the job's own place names are removed —
 * otherwise the matcher "confirms" candidates against terms like "(Ottawa)" and
 * reports meaningless evidence.
 */
export function titleFallbackSkills(
  title: string,
  placeNames: string[] = [],
  maxTerms = 6,
): string[] {
  const places = new Set(
    placeNames.flatMap((p) => lc(p).split(/[\s,]+/)).filter(Boolean),
  );
  const withoutGroups = title.replace(/[([{][^)\]}]*[)\]}]?/g, " ");
  const tokens = withoutGroups
    .split(/[\s/|,&+]+/)
    .map((t) => t.replace(/^[-–—.:;"']+|[-–—.:;"']+$/g, "").trim())
    .filter(Boolean);

  const kept: string[] = [];
  for (const token of tokens) {
    const key = lc(token);
    if (key.length <= 2) continue;
    if (NON_SKILL_TITLE_WORDS.has(key)) continue;
    if (key.startsWith("non-")) continue;
    if (places.has(key)) continue;
    if (looksLikeJobCode(token)) continue;
    if (kept.some((k) => lc(k) === key)) continue;
    kept.push(token);
    if (kept.length >= maxTerms) break;
  }
  return kept;
}

function boolOrNull(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

export interface ExtractJobRequirementsArgs {
  job: Record<string, unknown>;
  mustHaveSkills?: string[];
  niceToHaveSkills?: string[];
}

export function extractJobRequirements(args: ExtractJobRequirementsArgs): JobRequirements {
  const job = args.job;
  const title = str(job.title);
  const address = recordOf(job.address);
  const jobCity = str(address.city);
  const jobState = str(address.state);
  const locationLabel = [jobCity, jobState].filter(Boolean).join(", ") || "Unspecified";

  const work = detectWorkArrangement(job);
  const parsed: ParsedRequirement[] = [
    {
      key: "workArrangement",
      label: "Work arrangement",
      value: work.arrangement,
      source: work.source,
      confidence: work.source === "structured" ? "high" : work.source === "description" ? "medium" : "low",
      hard: work.arrangement === "onsite" || work.arrangement === "hybrid",
    },
  ];

  let mustHave: string[];
  let skillDerivation: JobRequirements["skillDerivation"];
  if (args.mustHaveSkills && args.mustHaveSkills.length > 0) {
    mustHave = args.mustHaveSkills.map((s) => s.trim()).filter(Boolean);
    skillDerivation = "user";
  } else {
    const extracted = extractJobSkills(job);
    if (extracted.skills.length > 0) {
      mustHave = extracted.skills;
      skillDerivation = extracted.source === "skillList" ? "skillList" : "skills";
    } else {
      mustHave = titleFallbackSkills(title, [
        jobCity,
        jobState,
        str(recordOf(job.address).countryName),
      ]);
      skillDerivation = "title_fallback";
    }
  }
  const niceToHave = (args.niceToHaveSkills ?? []).map((s) => s.trim()).filter(Boolean);

  parsed.push({
    key: "mustHaveSkills",
    label: "Required skills",
    value: mustHave,
    source:
      skillDerivation === "user"
        ? "user"
        : skillDerivation === "title_fallback"
          ? "fallback"
          : "structured",
    confidence: skillDerivation === "title_fallback" ? "low" : "high",
    hard: true,
  });
  if (niceToHave.length > 0) {
    parsed.push({
      key: "niceToHaveSkills",
      label: "Nice-to-have skills",
      value: niceToHave,
      source: "user",
      confidence: "high",
      hard: false,
    });
  }

  const yearsRequired = num(job.yearsRequired);
  if (yearsRequired !== null && yearsRequired > 0) {
    parsed.push({
      key: "yearsRequired",
      label: "Minimum experience (years)",
      value: yearsRequired,
      source: "structured",
      confidence: "high",
      hard: true,
    });
  }

  const employmentType = str(job.employmentType) || null;
  if (employmentType) {
    parsed.push({
      key: "employmentType",
      label: "Employment type",
      value: employmentType,
      source: "structured",
      confidence: "medium",
      hard: false,
    });
  }

  const educationDegree = str(job.educationDegree) || null;
  if (educationDegree) {
    parsed.push({
      key: "educationDegree",
      label: "Education requirements",
      value: educationDegree,
      source: "structured",
      confidence: "medium",
      hard: false,
    });
  }

  const willSponsor = boolOrNull(job.willSponsor);
  if (willSponsor !== null) {
    parsed.push({
      key: "willSponsor",
      label: "Visa sponsorship provided",
      value: willSponsor,
      source: "structured",
      confidence: "high",
      // Only hard when the job will NOT sponsor — then unauthorized candidates fail.
      hard: willSponsor === false,
    });
  }

  // Bullhorn often stores unset pay as 0 — treat non-positive as absent.
  const positiveMoney = (v: unknown): number | null => {
    const n = num(v);
    return n !== null && n > 0 ? n : null;
  };
  const compensation: JobCompensation = {
    low: positiveMoney(job.salary),
    high: positiveMoney(job.customFloat1),
    payRate: positiveMoney(job.payRate),
    unit: str(job.salaryUnit) || null,
  };
  if (
    compensation.low !== null ||
    compensation.high !== null ||
    compensation.payRate !== null
  ) {
    parsed.push({
      key: "compensation",
      label: "Compensation",
      value: compensation,
      source: "structured",
      confidence: compensation.unit ? "medium" : "low",
      hard: false,
    });
  }

  if (jobCity || jobState) {
    parsed.push({
      key: "jobLocation",
      label: "Job location",
      value: locationLabel,
      source: "structured",
      confidence: "high",
      hard: work.arrangement === "onsite" || work.arrangement === "hybrid",
    });
  }

  return {
    title: title || "(untitled)",
    jobCity,
    jobState,
    locationLabel,
    workArrangement: work.arrangement,
    workArrangementSource: work.source,
    mustHaveSkills: mustHave,
    niceToHaveSkills: niceToHave,
    yearsRequired: yearsRequired !== null && yearsRequired > 0 ? yearsRequired : null,
    employmentType,
    educationDegree,
    willSponsor,
    compensation,
    parsedRequirements: parsed,
    skillDerivation,
  };
}
