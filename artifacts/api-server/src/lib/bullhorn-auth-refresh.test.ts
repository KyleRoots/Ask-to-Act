import { describe, it, expect } from "vitest";
import { bullhornAuthRefreshEnabled } from "./bullhorn-auth-refresh-helpers.js";

describe("bullhornAuthRefreshEnabled", () => {
  it("defaults on and respects BULLHORN_AUTH_REFRESH=0", () => {
    expect(bullhornAuthRefreshEnabled({})).toBe(true);
    expect(bullhornAuthRefreshEnabled({ BULLHORN_AUTH_REFRESH: "1" })).toBe(true);
    expect(bullhornAuthRefreshEnabled({ BULLHORN_AUTH_REFRESH: "0" })).toBe(false);
  });
});
