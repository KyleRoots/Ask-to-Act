import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./stripe/storage.js", () => ({
  stripeStorage: {
    resolveFirmStatus: vi.fn(),
  },
}));

import { stripeStorage } from "./stripe/storage.js";
import {
  assertFirmEntitled,
  entitlementsEnforced,
  FirmNotEntitledError,
  isEntitledSubscriptionStatus,
  resolveFirmEntitlement,
} from "./entitlements.js";

describe("entitlements", () => {
  const prev = process.env["ENTITLEMENTS_ENFORCED"];

  afterEach(() => {
    if (prev === undefined) delete process.env["ENTITLEMENTS_ENFORCED"];
    else process.env["ENTITLEMENTS_ENFORCED"] = prev;
    vi.clearAllMocks();
  });

  it("defaults to not enforced", () => {
    expect(entitlementsEnforced({})).toBe(false);
    expect(entitlementsEnforced({ ENTITLEMENTS_ENFORCED: "" })).toBe(false);
    expect(entitlementsEnforced({ ENTITLEMENTS_ENFORCED: "0" })).toBe(false);
  });

  it("enforces when set to 1/true", () => {
    expect(entitlementsEnforced({ ENTITLEMENTS_ENFORCED: "1" })).toBe(true);
    expect(entitlementsEnforced({ ENTITLEMENTS_ENFORCED: "true" })).toBe(true);
    expect(entitlementsEnforced({ ENTITLEMENTS_ENFORCED: "YES" })).toBe(true);
  });

  it("treats active/trialing as entitled", () => {
    expect(isEntitledSubscriptionStatus("active")).toBe(true);
    expect(isEntitledSubscriptionStatus("trialing")).toBe(true);
    expect(isEntitledSubscriptionStatus("none")).toBe(false);
    expect(isEntitledSubscriptionStatus("past_due")).toBe(false);
  });

  it("assertFirmEntitled is a no-op when not enforced", async () => {
    delete process.env["ENTITLEMENTS_ENFORCED"];
    await expect(assertFirmEntitled("firm-x")).resolves.toBeUndefined();
    expect(stripeStorage.resolveFirmStatus).not.toHaveBeenCalled();
  });

  it("assertFirmEntitled allows active when enforced", async () => {
    process.env["ENTITLEMENTS_ENFORCED"] = "1";
    vi.mocked(stripeStorage.resolveFirmStatus).mockResolvedValue("active");
    await expect(assertFirmEntitled("firm-x")).resolves.toBeUndefined();
  });

  it("assertFirmEntitled throws 402 when not entitled", async () => {
    process.env["ENTITLEMENTS_ENFORCED"] = "1";
    vi.mocked(stripeStorage.resolveFirmStatus).mockResolvedValue("none");
    await expect(assertFirmEntitled("firm-x")).rejects.toBeInstanceOf(
      FirmNotEntitledError,
    );
    try {
      await assertFirmEntitled("firm-x");
    } catch (err) {
      expect(err).toBeInstanceOf(FirmNotEntitledError);
      expect((err as FirmNotEntitledError).statusCode).toBe(402);
      expect((err as FirmNotEntitledError).entitlementStatus).toBe("none");
    }
  });

  it("resolveFirmEntitlement maps stripe status", async () => {
    vi.mocked(stripeStorage.resolveFirmStatus).mockResolvedValue("trialing");
    await expect(resolveFirmEntitlement("f1")).resolves.toEqual({
      entitled: true,
      status: "trialing",
    });
  });
});
