import { describe, it, expect } from "vitest";
import { expandConcept, expandConcepts } from "./search-taxonomy.js";

// Normalized membership helper: does the expansion contain `term` (case/sep-insensitive)?
function has(group: string[], term: string): boolean {
  const n = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return group.map(n).includes(n(term));
}

describe("expandConcept", () => {
  it("keeps the caller's original term first", () => {
    const g = expandConcept("React");
    expect(g[0]).toBe("React");
  });

  it("expands framework synonyms and orthographic variants", () => {
    const g = expandConcept("React");
    expect(has(g, "react.js")).toBe(true);
    expect(has(g, "reactjs")).toBe(true);
    expect(has(g, "react js")).toBe(true);
  });

  it("expands abbreviations to full forms (AWS → Amazon Web Services)", () => {
    expect(has(expandConcept("AWS"), "amazon web services")).toBe(true);
    expect(has(expandConcept("k8s"), "kubernetes")).toBe(true);
  });

  it("expands a clearance concept to its variants", () => {
    const g = expandConcept("TS/SCI");
    expect(has(g, "top secret")).toBe(true);
  });

  it("expands title families (SDET ↔ test automation / QA automation)", () => {
    const g = expandConcept("SDET");
    expect(has(g, "test automation engineer")).toBe(true);
    expect(has(g, "qa automation engineer")).toBe(true);
  });

  it("expands separator variants for multi-word roles", () => {
    const g = expandConcept("full stack");
    expect(has(g, "fullstack")).toBe(true);
    expect(has(g, "full-stack")).toBe(true);
  });

  it("expands TypeScript → ts (directional) but never bare ts → TypeScript", () => {
    // TypeScript should pull in the "ts" abbreviation for recall.
    expect(has(expandConcept("TypeScript"), "ts")).toBe(true);
    // A bare "TS" (ambiguous: Top Secret vs TypeScript) must NOT expand to TypeScript.
    const ts = expandConcept("TS");
    expect(has(ts, "typescript")).toBe(false);
  });

  it("does not over-expand other ambiguous abbreviations", () => {
    expect(has(expandConcept("PM"), "project manager")).toBe(false);
    expect(has(expandConcept("ML"), "machine learning")).toBe(false);
  });

  it("returns a singleton for an unknown term (no false synonyms)", () => {
    const g = expandConcept("Snowflake");
    expect(g).toEqual(["Snowflake"]);
  });

  it("caps the number of expansions", () => {
    const g = expandConcept("React");
    expect(g.length).toBeLessThanOrEqual(8);
  });

  it("trims and ignores empty input", () => {
    expect(expandConcept("   ")).toEqual([]);
  });
});

describe("expandConcepts", () => {
  it("keeps distinct concepts as separate OR-groups", () => {
    const groups = expandConcepts(["Java", "AWS"]);
    expect(groups.length).toBe(2);
    expect(has(groups[1], "amazon web services")).toBe(true);
  });

  it("drops empty concepts", () => {
    expect(expandConcepts(["React", "  "]).length).toBe(1);
  });
});
