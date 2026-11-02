import { describe, expect, it } from "vitest";
import {
  MERGE_VALUE_MAX_CHARS,
  mergeValuesFromRecord,
  parseEmailTemplates,
  renderEmail,
  sanitizeMergeValue,
} from "./email-merge-fields.js";

function render(
  subject: string,
  body: string,
  record: Record<string, unknown>,
) {
  const parsed = parseEmailTemplates({ subject, body });
  if (!parsed.ok) throw new Error(parsed.message);
  return renderEmail(parsed.parsed, mergeValuesFromRecord(record));
}

describe("email merge fields", () => {
  it("renders firstName, lastName and fullName from the record", () => {
    const out = render(
      "Hi {{firstName}}",
      "Dear {{ fullName }},\nThanks, {{lastName}} family.",
      { firstName: "Jane", lastName: "Doe", name: "Jane Q. Doe" },
    );
    expect(out).toEqual({
      ok: true,
      subject: "Hi Jane",
      body: "Dear Jane Q. Doe,\nThanks, Doe family.",
      usedFallback: false,
    });
  });

  it("builds fullName from first and last when Bullhorn name is empty", () => {
    expect(
      mergeValuesFromRecord({ firstName: "Ana", lastName: "Li", name: "" }),
    ).toEqual({
      firstName: "Ana",
      lastName: "Li",
      fullName: "Ana Li",
    });
  });

  it("uses the fallback only when the value is missing", () => {
    expect(
      render("Hi {{firstName|there}}", "x", { firstName: "Sam" }),
    ).toMatchObject({
      subject: "Hi Sam",
      usedFallback: false,
    });
    expect(
      render("Hi {{firstName| there }}", "x", { firstName: "  " }),
    ).toMatchObject({
      subject: "Hi there",
      usedFallback: true,
    });
  });

  it("leaves templates with no merge fields unchanged", () => {
    expect(render("Quick update", "Body {single} braces", {})).toMatchObject({
      ok: true,
      subject: "Quick update",
      body: "Body {single} braces",
    });
  });

  it("rejects an unknown or misspelled tag with a clear message", () => {
    const result = parseEmailTemplates({
      subject: "Hi {{fistName}}",
      body: "Body {{Email}}",
    });
    expect(result).toMatchObject({ ok: false, error: "unknown_merge_field" });
    if (result.ok) return;
    expect(result.message).toContain("{{fistName}} in the subject");
    expect(result.message).toContain(
      "{{firstName}}, {{lastName}}, {{fullName}}",
    );
  });

  it("suggests the right casing for a wrongly cased tag", () => {
    const result = parseEmailTemplates({
      subject: "x",
      body: "Hi {{FirstName}}",
    });
    expect(result).toMatchObject({ ok: false, error: "unknown_merge_field" });
    if (result.ok) return;
    expect(result.message).toContain("did you mean {{firstName}}?");
  });

  it.each([
    ["unclosed tag", "Hi {{firstName"],
    ["stray closing braces", "Hi }} there"],
    ["empty fallback", "Hi {{firstName|}}"],
    ["two fallbacks", "Hi {{firstName|a|b}}"],
    ["nested braces", "Hi {{{firstName}}}"],
    ["empty tag", "Hi {{}}"],
    ["overlong fallback", `Hi {{firstName|${"x".repeat(61)}}}`],
  ])("rejects a malformed tag: %s", (_label, body) => {
    expect(parseEmailTemplates({ subject: "s", body })).toMatchObject({
      ok: false,
      error: "invalid_merge_field",
    });
  });

  it("reports the missing field when there is no value and no fallback", () => {
    expect(
      render("Hi {{firstName}}", "Hello {{lastName|friend}}", { lastName: "" }),
    ).toEqual({
      ok: false,
      missingFields: ["firstName"],
    });
  });

  it("strips CR/LF and other control characters from values placed in the subject", () => {
    const out = render("Hi {{firstName}}", "Body", {
      firstName: "Ann\r\nBcc: attacker@example.com\u2028x",
    });
    expect(out).toMatchObject({
      ok: true,
      subject: "Hi Ann Bcc: attacker@example.com x",
    });
    if (!out.ok) return;
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it("never lets a Bullhorn value emit a literal merge tag", () => {
    const out = render("Hi {{firstName}}", "Body {{lastName}}", {
      firstName: "{{lastName}}",
      lastName: "}}x{{",
    });
    expect(out).toMatchObject({
      ok: true,
      subject: "Hi lastName",
      body: "Body x",
    });
  });

  it("caps value length", () => {
    const long = "A".repeat(MERGE_VALUE_MAX_CHARS + 50);
    expect(sanitizeMergeValue(long)).toHaveLength(MERGE_VALUE_MAX_CHARS);
    const out = render("Hi {{firstName}}", "x", { firstName: long });
    expect(out.ok && out.subject).toBe(
      `Hi ${"A".repeat(MERGE_VALUE_MAX_CHARS)}`,
    );
  });
});
