import { describe, it, expect } from "vitest";
import { sanitizeJobRecord } from "./bullhorn-client.js";

const desc = (r: unknown) =>
  (((r as { data?: Record<string, unknown> }).data ??
    (r as Record<string, unknown>)).publicDescription as string | undefined) ?? "";

describe("sanitizeJobRecord", () => {
  it("strips HTML from publicDescription", () => {
    const out = sanitizeJobRecord({
      data: { id: 1, publicDescription: "<p>Hello <b>world</b></p><div>line two</div>" },
    });
    const text = desc(out);
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).toContain("line two");
  });

  it("caps very long descriptions and adds a truncation marker", () => {
    const long = "x".repeat(20000);
    const out = sanitizeJobRecord({ data: { id: 1, publicDescription: long } });
    const text = desc(out);
    expect(text.length).toBeLessThan(long.length);
    expect(text).toMatch(/truncated/i);
  });

  it("leaves short plain-text descriptions unchanged", () => {
    const out = sanitizeJobRecord({ data: { id: 1, publicDescription: "Just plain text." } });
    expect(desc(out)).toBe("Just plain text.");
  });

  it("works on an unwrapped (non-data-enveloped) record", () => {
    const out = sanitizeJobRecord({ id: 1, publicDescription: "<p>Inline</p>" });
    expect(desc(out)).toBe("Inline");
  });

  it("tolerates missing/empty publicDescription and odd inputs", () => {
    expect(() => sanitizeJobRecord({ data: { id: 1 } })).not.toThrow();
    expect(() => sanitizeJobRecord(null)).not.toThrow();
    expect(() => sanitizeJobRecord("nope")).not.toThrow();
    expect(() => sanitizeJobRecord({ data: { id: 1, publicDescription: "" } })).not.toThrow();
  });
});
