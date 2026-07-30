import { describe, it, expect } from "vitest";
import {
  detectWorkArrangement,
  extractJobRequirements,
  extractJobSkills,
  normalizeStringList,
} from "./match-requirements.js";
import { evaluateCandidate } from "./match-criteria.js";
import { toConcepts } from "./search-taxonomy.js";

describe("normalizeStringList", () => {
  it("accepts scalar and array onSite values", () => {
    expect(normalizeStringList("Remote")).toEqual(["Remote"]);
    expect(normalizeStringList(["Hybrid", "Remote"])).toEqual(["Hybrid", "Remote"]);
  });
});

describe("detectWorkArrangement", () => {
  it("prefers structured onSite array over description", () => {
    const r = detectWorkArrangement({
      onSite: ["Remote"],
      publicDescription: "This is an onsite role in the office.",
    });
    expect(r).toMatchObject({ arrangement: "remote", source: "structured" });
  });

  it("uses isWorkFromHome when onSite is absent", () => {
    expect(detectWorkArrangement({ isWorkFromHome: true }).arrangement).toBe("remote");
    expect(detectWorkArrangement({ isWorkFromHome: false }).arrangement).toBe("onsite");
  });

  it("falls back to description heuristics", () => {
    expect(
      detectWorkArrangement({ publicDescription: "Hybrid schedule, 3 days in office" }).arrangement,
    ).toBe("hybrid");
  });
});

describe("extractJobSkills", () => {
  it("reads TO_MANY skill names and skillList text", () => {
    expect(
      extractJobSkills({
        skills: { data: [{ name: "Python" }, { name: "Pytest" }] },
      }).skills,
    ).toEqual(["Python", "Pytest"]);
    expect(extractJobSkills({ skillList: "React, TypeScript" }).skills).toEqual([
      "React",
      "TypeScript",
    ]);
  });
});

describe("extractJobRequirements", () => {
  it("builds parsedRequirements with sources", () => {
    const req = extractJobRequirements({
      job: {
        title: "Python Developer",
        skills: "Python, Pytest",
        onSite: ["Onsite"],
        address: { city: "Ottawa", state: "ON" },
        yearsRequired: 5,
        willSponsor: false,
        salary: 90000,
        customFloat1: 110000,
        salaryUnit: "per year",
        employmentType: "Permanent",
      },
    });
    expect(req.workArrangement).toBe("onsite");
    expect(req.yearsRequired).toBe(5);
    expect(req.willSponsor).toBe(false);
    expect(req.mustHaveSkills).toEqual(["Python", "Pytest"]);
    expect(req.parsedRequirements.some((p) => p.key === "willSponsor" && p.hard)).toBe(true);
  });

  it("falls back to title tokens when skills are empty", () => {
    const req = extractJobRequirements({
      job: { title: "Senior Python Developer", skills: "" },
    });
    expect(req.skillDerivation).toBe("title_fallback");
    expect(req.mustHaveSkills).toContain("Python");
  });

  it("treats Bullhorn zero pay placeholders as unset compensation", () => {
    const req = extractJobRequirements({
      job: {
        title: "Software Developer",
        salary: 0,
        payRate: 0,
        salaryUnit: "Yearly",
      },
    });
    expect(req.compensation).toEqual({
      low: null,
      high: null,
      payRate: null,
      unit: "Yearly",
    });
    expect(req.parsedRequirements.some((p) => p.key === "compensation")).toBe(false);
  });
});

describe("evaluateCandidate", () => {
  const baseReq = extractJobRequirements({
    job: {
      title: "Python Developer",
      skills: "Python",
      onSite: ["Onsite"],
      address: { city: "Ottawa", state: "ON" },
      yearsRequired: 5,
      willSponsor: false,
      employmentType: "Contract",
      salary: 50,
      salaryUnit: "per hour",
    },
  });
  const concepts = toConcepts(["Python"]);

  it("passes local onsite candidates with verified skills and authorization", () => {
    const ev = evaluateCandidate({
      candidate: {
        id: 1,
        address: { city: "Ottawa", state: "ON" },
        workAuthorized: true,
        hourlyRate: 55,
        employmentPreference: "Contract",
      },
      requirements: baseReq,
      mustConcepts: concepts,
      resumeConfirmed: ["Python"],
      resumeMissing: [],
      experience: {
        yearsExperience: 7,
        careerSpanYears: 8,
        roleCount: 3,
        currentRole: null,
        lastActivityMonthsAgo: 0,
        seniority: "senior",
        basis: "work history",
      },
      localOnly: false,
    });
    expect(ev.eligible).toBe(true);
    expect(ev.needsVerification).toBe(false);
    expect(ev.locationFit).toBe("local");
  });

  it("fails unauthorized candidates when job will not sponsor", () => {
    const ev = evaluateCandidate({
      candidate: {
        id: 2,
        address: { city: "Ottawa", state: "ON" },
        workAuthorized: false,
      },
      requirements: baseReq,
      mustConcepts: concepts,
      resumeConfirmed: ["Python"],
      resumeMissing: [],
      experience: {
        yearsExperience: 6,
        careerSpanYears: 6,
        roleCount: 2,
        currentRole: null,
        lastActivityMonthsAgo: 0,
        seniority: "senior",
        basis: "work history",
      },
      localOnly: false,
    });
    expect(ev.eligible).toBe(false);
    expect(ev.criteria.find((c) => c.key === "authorization")?.outcome).toBe("fail");
  });

  it("marks unknown authorization without inferring from demographics", () => {
    const ev = evaluateCandidate({
      candidate: {
        id: 3,
        address: { city: "Ottawa", state: "ON" },
        // deliberately no workAuthorized / no nationality inference
      },
      requirements: baseReq,
      mustConcepts: concepts,
      resumeConfirmed: ["Python"],
      resumeMissing: [],
      experience: {
        yearsExperience: 6,
        careerSpanYears: 6,
        roleCount: 1,
        currentRole: null,
        lastActivityMonthsAgo: 0,
        seniority: "senior",
        basis: "work history",
      },
      localOnly: false,
    });
    expect(ev.eligible).toBe(true);
    expect(ev.needsVerification).toBe(true);
    expect(ev.criteria.find((c) => c.key === "authorization")?.outcome).toBe("unknown");
  });

  it("treats remote roles as location-pass regardless of candidate city", () => {
    const remoteReq = extractJobRequirements({
      job: {
        title: "Python Developer",
        skills: "Python",
        onSite: ["Remote"],
        address: { city: "Cairo", state: "" },
      },
    });
    const ev = evaluateCandidate({
      candidate: { id: 4, address: { city: "Vancouver", state: "BC" } },
      requirements: remoteReq,
      mustConcepts: concepts,
      resumeConfirmed: ["Python"],
      resumeMissing: [],
      experience: null,
      localOnly: false,
    });
    expect(ev.locationFit).toBe("remote_ok");
    expect(ev.criteria.find((c) => c.key === "location")?.outcome).toBe("pass");
  });

  it("fails clear out-of-area when willRelocate=false on onsite roles", () => {
    const ev = evaluateCandidate({
      candidate: {
        id: 5,
        address: { city: "Vancouver", state: "BC" },
        willRelocate: false,
        workAuthorized: true,
      },
      requirements: baseReq,
      mustConcepts: concepts,
      resumeConfirmed: ["Python"],
      resumeMissing: [],
      experience: {
        yearsExperience: 8,
        careerSpanYears: 8,
        roleCount: 2,
        currentRole: null,
        lastActivityMonthsAgo: 0,
        seniority: "senior",
        basis: "work history",
      },
      localOnly: false,
    });
    expect(ev.eligible).toBe(false);
    expect(ev.locationFit).toBe("out_of_area");
  });

  it("leaves compensation unit mismatches as unknown", () => {
    const ev = evaluateCandidate({
      candidate: {
        id: 6,
        address: { city: "Ottawa", state: "ON" },
        workAuthorized: true,
        salary: 120000, // annual desire vs hourly job band
      },
      requirements: baseReq,
      mustConcepts: concepts,
      resumeConfirmed: ["Python"],
      resumeMissing: [],
      experience: {
        yearsExperience: 6,
        careerSpanYears: 6,
        roleCount: 1,
        currentRole: null,
        lastActivityMonthsAgo: 0,
        seniority: "senior",
        basis: "work history",
      },
      localOnly: false,
    });
    expect(ev.criteria.find((c) => c.key === "compensation")?.outcome).toBe("unknown");
  });
});
