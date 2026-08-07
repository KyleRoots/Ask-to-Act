import { describe, it, expect } from "vitest";
import { publicErrorReason } from "./public-error.js";

describe("publicErrorReason", () => {
  it("returns fallback for empty / non-Error values", () => {
    expect(publicErrorReason(null, "fallback")).toBe("fallback");
    expect(publicErrorReason({}, "fallback")).toBe("fallback");
    expect(publicErrorReason(new Error(""), "fallback")).toBe("fallback");
  });

  it("uses Error.message when present", () => {
    expect(publicErrorReason(new Error("Bullhorn loginInfo failed (503)"), "fallback")).toBe(
      "Bullhorn loginInfo failed (503)",
    );
  });

  it("redacts secret-like substrings", () => {
    const msg =
      "exchange failed Bearer abc.def.ghi client_secret=sekret refresh_token=rtok access_token=atok password=hunter2";
    const out = publicErrorReason(new Error(msg), "fallback");
    expect(out).not.toContain("sekret");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("Bearer abc");
    expect(out).toContain("[redacted]");
  });

  it("truncates long messages", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const out = publicErrorReason(new Error(long), "fallback", 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });
});
