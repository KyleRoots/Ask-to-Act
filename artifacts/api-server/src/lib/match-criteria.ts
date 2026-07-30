/**
 * Evaluate a candidate against structured job requirements.
 *
 * Outcomes are three-state for hard criteria: pass / fail / unknown.
 * Missing data never silently becomes a pass or a fabricated fail.
 */
import type { ExperienceSummary } from "./candidate-experience.js";
import type { ReconciledExperience } from "./resume-experience.js";
import type { JobRequirements, WorkArrangement } from "./match-requirements.js";
import { isLocalMatch, structuredConceptHits } from "./search-ranking.js";
import type { Concept } from "./search-taxonomy.js";
import { num, recordOf, str } from "./record-utils.js";

export type CriterionOutcome = "pass" | "fail" | "unknown" | "not_applicable";

export interface CriterionResult {
  key: string;
  label: string;
  outcome: CriterionOutcome;
  evidence: string;
}

export type LocationFit =
  | "local"
  | "relocatable"
  | "desired_location"
  | "remote_ok"
  | "out_of_area"
  | "unknown";

export interface CandidateEvaluation {
  /** No hard criterion failed. Unknowns may still require verification. */
  eligible: boolean;
  /** Hard criteria that are unknown / unverified. */
  needsVerification: boolean;
  locationFit: LocationFit;
  criteria: CriterionResult[];
}

function lc(s: string): string {
  return s.trim().toLowerCase();
}

function desiredLocationsMentionJob(
  desiredRaw: string,
  jobCity: string,
  jobState: string,
): boolean {
  if (!desiredRaw) return false;
  const desired = lc(desiredRaw);
  if (jobCity && desired.includes(lc(jobCity))) return true;
  if (jobState && desired.includes(lc(jobState))) return true;
  return false;
}

function boolOrNull(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

/** Normalize salary units enough to decide whether comparison is safe. */
function unitFamily(unit: string | null | undefined): "hourly" | "salary" | "unknown" {
  const u = lc(unit ?? "");
  if (!u) return "unknown";
  if (/\bhour|hr|hourly\b/.test(u)) return "hourly";
  if (/\byear|annual|annum|salary|yr\b/.test(u)) return "salary";
  if (/\bday|daily\b/.test(u)) return "unknown";
  return "unknown";
}

function candidateDesiredPay(cand: Record<string, unknown>): {
  amount: number | null;
  family: "hourly" | "salary" | "unknown";
} {
  const hourly = num(cand.hourlyRate);
  if (hourly !== null && hourly > 0) return { amount: hourly, family: "hourly" };
  const salary = num(cand.salary);
  if (salary !== null && salary > 0) return { amount: salary, family: "salary" };
  return { amount: null, family: "unknown" };
}

function jobPayBand(req: JobRequirements): {
  low: number | null;
  high: number | null;
  family: "hourly" | "salary" | "unknown";
} {
  const family = unitFamily(req.compensation.unit);
  if (family === "hourly" && req.compensation.payRate !== null) {
    return {
      low: req.compensation.payRate,
      high: req.compensation.high ?? req.compensation.payRate,
      family,
    };
  }
  return {
    low: req.compensation.low,
    high: req.compensation.high ?? req.compensation.low,
    family,
  };
}

function employmentCompatible(jobType: string, candidatePref: string): CriterionOutcome {
  if (!jobType) return "not_applicable";
  if (!candidatePref) return "unknown";
  const j = lc(jobType);
  const c = lc(candidatePref);
  // Soft check: exact or substring overlap counts as pass; clear opposite poles fail.
  if (c.includes(j) || j.includes(c)) return "pass";
  const jobContract = /\bcontract|temp|contractor\b/.test(j);
  const jobPerm = /\bperm|permanent|full[- ]?time|fte\b/.test(j);
  const candContract = /\bcontract|temp|contractor\b/.test(c);
  const candPerm = /\bperm|permanent|full[- ]?time|fte\b/.test(c);
  if ((jobContract && candPerm && !candContract) || (jobPerm && candContract && !candPerm)) {
    return "fail";
  }
  return "unknown";
}

export interface EvaluateCandidateArgs {
  candidate: Record<string, unknown>;
  requirements: JobRequirements;
  mustConcepts: Concept[];
  /** Résumé-confirmed concept labels (canonical). */
  resumeConfirmed: string[];
  /** Résumé-missing concept labels (canonical). */
  resumeMissing: string[];
  experience: ExperienceSummary | null;
  /** Résumé-vs-work-history reconciliation; absent means work history only. */
  reconciledExperience?: ReconciledExperience | null;
  /** When true, out-of-area is a hard fail for onsite/hybrid. */
  localOnly: boolean;
}

export function evaluateCandidate(args: EvaluateCandidateArgs): CandidateEvaluation {
  const { candidate: cand, requirements: req, mustConcepts } = args;
  const criteria: CriterionResult[] = [];

  // --- Skills ---
  const structuredHits = structuredConceptHits(cand, mustConcepts);
  const missing = args.resumeMissing.map((m) => m.trim()).filter(Boolean);
  if (mustConcepts.length === 0) {
    criteria.push({
      key: "skills",
      label: "Required skills",
      outcome: "not_applicable",
      evidence: "No required skills derived",
    });
  } else if (missing.length === 0 && args.resumeConfirmed.length === mustConcepts.length) {
    criteria.push({
      key: "skills",
      label: "Required skills",
      outcome: "pass",
      evidence: `Résumé confirmed: ${args.resumeConfirmed.join(", ")}`,
    });
  } else if (missing.length === mustConcepts.length && structuredHits.length === 0) {
    criteria.push({
      key: "skills",
      label: "Required skills",
      outcome: "fail",
      evidence: `No structured or résumé evidence for: ${mustConcepts.map((c) => c.canonical).join(", ")}`,
    });
  } else {
    criteria.push({
      key: "skills",
      label: "Required skills",
      outcome: "unknown",
      evidence:
        structuredHits.length > 0
          ? `Structured hits (${structuredHits.join(", ")}); résumé still missing: ${missing.join(", ") || "verification incomplete"}`
          : `Résumé missing/unverified: ${missing.join(", ") || "not checked"}`,
    });
  }

  // --- Location / work arrangement ---
  const arrangement: WorkArrangement = req.workArrangement;
  const local = isLocalMatch(cand, req.jobCity, req.jobState);
  const willRelocate = boolOrNull(cand.willRelocate);
  const desired = str(cand.desiredLocations);
  const desiredHit = desiredLocationsMentionJob(desired, req.jobCity, req.jobState);
  let locationFit: LocationFit = "unknown";

  if (arrangement === "remote" || arrangement === "no_preference") {
    locationFit = "remote_ok";
    criteria.push({
      key: "location",
      label: "Location / work arrangement",
      outcome: "pass",
      evidence:
        arrangement === "remote"
          ? "Role is remote — candidate location is not a hard constraint"
          : "Role has no location preference",
    });
  } else if (!req.jobCity && !req.jobState) {
    locationFit = "unknown";
    criteria.push({
      key: "location",
      label: "Location / work arrangement",
      outcome: "unknown",
      evidence: "Job has no city/state to compare against",
    });
  } else if (local) {
    locationFit = "local";
    criteria.push({
      key: "location",
      label: "Location / work arrangement",
      outcome: "pass",
      evidence: `Candidate location matches job (${req.locationLabel})`,
    });
  } else if (desiredHit) {
    locationFit = "desired_location";
    criteria.push({
      key: "location",
      label: "Location / work arrangement",
      outcome: "pass",
      evidence: `Desired locations mention job area (${desired})`,
    });
  } else if (willRelocate === true) {
    locationFit = "relocatable";
    criteria.push({
      key: "location",
      label: "Location / work arrangement",
      outcome: "pass",
      evidence: "Candidate marked willing to relocate",
    });
  } else {
    const addr = recordOf(cand.address);
    const candLoc = [str(addr.city), str(addr.state)].filter(Boolean).join(", ");
    if (!candLoc && willRelocate === null && !desired) {
      locationFit = "unknown";
      criteria.push({
        key: "location",
        label: "Location / work arrangement",
        outcome: "unknown",
        evidence: "Candidate location and relocation preference are unknown",
      });
    } else if (args.localOnly) {
      locationFit = "out_of_area";
      criteria.push({
        key: "location",
        label: "Location / work arrangement",
        outcome: "fail",
        evidence: `Out of area (${candLoc || "unknown"}) and localOnly=true`,
      });
    } else if (
      willRelocate === false &&
      candLoc &&
      (arrangement === "onsite" || arrangement === "hybrid")
    ) {
      // Explicit mismatch: known different location AND will not relocate.
      locationFit = "out_of_area";
      criteria.push({
        key: "location",
        label: "Location / work arrangement",
        outcome: "fail",
        evidence: `Candidate in ${candLoc}, willRelocate=false, role is ${arrangement}`,
      });
    } else {
      locationFit = candLoc ? "out_of_area" : "unknown";
      criteria.push({
        key: "location",
        label: "Location / work arrangement",
        outcome: "unknown",
        evidence: candLoc
          ? `Candidate in ${candLoc}; relocation/desired-location not confirmed for ${arrangement} role`
          : "Location fit unresolved",
      });
    }
  }

  // --- Experience ---
  if (req.yearsRequired !== null) {
    const reconciled = args.reconciledExperience ?? null;
    const historyYears = args.experience?.yearsExperience ?? null;
    const structuredYears = num(cand.experience);
    const effective = reconciled?.years ?? historyYears ?? structuredYears;
    const conflicting = reconciled?.agreement === "conflict";
    if (effective === null) {
      criteria.push({
        key: "experience",
        label: "Minimum experience",
        outcome: "unknown",
        evidence: `Need ≥${req.yearsRequired} years; candidate tenure not derivable`,
      });
    } else if (conflicting) {
      // Bullhorn's parsed work history and the résumé disagree materially. Saying either
      // "qualified" or "too junior" here would be a guess dressed up as a finding.
      criteria.push({
        key: "experience",
        label: "Minimum experience",
        outcome: "unknown",
        evidence:
          `Need ≥${req.yearsRequired} years; sources disagree ` +
          `(résumé ~${reconciled?.resumeYears} vs work history ~${historyYears?.toFixed(1)}) — confirm with the candidate`,
      });
    } else if (effective + 1e-9 >= req.yearsRequired) {
      criteria.push({
        key: "experience",
        label: "Minimum experience",
        outcome: "pass",
        evidence: `~${effective.toFixed(1)} years (≥${req.yearsRequired} required)${
          reconciled?.agreement === "resume_only" ? " — from résumé text" : ""
        }`,
      });
    } else {
      criteria.push({
        key: "experience",
        label: "Minimum experience",
        outcome: "fail",
        evidence: `~${effective.toFixed(1)} years < ${req.yearsRequired} required`,
      });
    }
  }

  // --- Work authorization / sponsorship ---
  // Never infer from nationality, address, or visa-type labels.
  if (req.willSponsor === false) {
    const authorized = boolOrNull(cand.workAuthorized);
    if (authorized === true) {
      criteria.push({
        key: "authorization",
        label: "Work authorization",
        outcome: "pass",
        evidence: "Job does not sponsor; candidate marked workAuthorized=true",
      });
    } else if (authorized === false) {
      criteria.push({
        key: "authorization",
        label: "Work authorization",
        outcome: "fail",
        evidence: "Job does not sponsor; candidate workAuthorized=false",
      });
    } else {
      criteria.push({
        key: "authorization",
        label: "Work authorization",
        outcome: "unknown",
        evidence: "Job does not sponsor; candidate workAuthorized is unset — do not infer from demographics",
      });
    }
  } else if (req.willSponsor === true) {
    criteria.push({
      key: "authorization",
      label: "Work authorization",
      outcome: "not_applicable",
      evidence: "Job may provide sponsorship — not used as a hard gate",
    });
  }

  // --- Compensation (preference / soft unless units compatible and clearly incompatible) ---
  const band = jobPayBand(req);
  const candPay = candidateDesiredPay(cand);
  if (band.low !== null || band.high !== null) {
    if (candPay.amount === null) {
      criteria.push({
        key: "compensation",
        label: "Compensation",
        outcome: "unknown",
        evidence: "Candidate desired pay not set",
      });
    } else if (
      band.family === "unknown" ||
      candPay.family === "unknown" ||
      band.family !== candPay.family
    ) {
      criteria.push({
        key: "compensation",
        label: "Compensation",
        outcome: "unknown",
        evidence: `Pay unit mismatch or unknown (job=${req.compensation.unit || "?"}, candidate=${candPay.family})`,
      });
    } else {
      const high = band.high ?? band.low!;
      const low = band.low ?? band.high!;
      if (candPay.amount <= high * 1.15) {
        criteria.push({
          key: "compensation",
          label: "Compensation",
          outcome: "pass",
          evidence: `Candidate wants ${candPay.amount} within/near job band ${low}-${high} ${req.compensation.unit || ""}`.trim(),
        });
      } else {
        criteria.push({
          key: "compensation",
          label: "Compensation",
          outcome: "unknown",
          evidence: `Candidate wants ${candPay.amount} above job high ${high} — confirm before treating as mismatch`,
        });
      }
    }
  }

  // --- Employment type (soft) ---
  if (req.employmentType) {
    const pref = str(cand.employmentPreference) || str(cand.employeeType);
    const outcome = employmentCompatible(req.employmentType, pref);
    criteria.push({
      key: "employmentType",
      label: "Employment type",
      outcome,
      evidence:
        outcome === "pass"
          ? `Compatible with ${req.employmentType}`
          : outcome === "fail"
            ? `Candidate preference "${pref}" conflicts with ${req.employmentType}`
            : pref
              ? `Could not confirm "${pref}" vs ${req.employmentType}`
              : `Candidate employment preference unset vs ${req.employmentType}`,
    });
  }

  const hardKeys = new Set(
    req.parsedRequirements.filter((p) => p.hard).map((p) => p.key),
  );
  // Skills + location + experience + authorization are the hard evaluators we emit.
  const hardOutcomes = criteria.filter((c) => {
    if (c.key === "skills") return hardKeys.has("mustHaveSkills");
    if (c.key === "location") return hardKeys.has("jobLocation") || hardKeys.has("workArrangement");
    if (c.key === "experience") return hardKeys.has("yearsRequired");
    if (c.key === "authorization") return hardKeys.has("willSponsor");
    return false;
  });

  const eligible = hardOutcomes.every((c) => c.outcome !== "fail");
  const needsVerification = hardOutcomes.some((c) => c.outcome === "unknown");

  return {
    eligible,
    needsVerification,
    locationFit,
    criteria,
  };
}
