import { describe, it, expect, vi } from "vitest";
import {
  buildCreateJobOrderBody,
  type CreateJobOrderDefaultDeps,
} from "./create-job-order-defaults.js";

function deps(overrides: Partial<CreateJobOrderDefaultDeps> = {}): CreateJobOrderDefaultDeps {
  return {
    resolveSessionOwnerId: vi.fn(async () => 99),
    findUserIdByExactEmail: vi.fn(async () => null),
    fetchCompanyAddress: vi.fn(async () => ({
      address1: "500 Palladium Dr",
      city: "Ottawa",
      state: "ON",
      zip: "K2V 1C2",
      countryName: "Canada",
    })),
    fetchUserPrimaryDepartmentName: vi.fn(async () => "MYT-Ottawa"),
    listInternalDepartmentOptions: vi.fn(async () => [
      "MYT-Ottawa",
      "MYT-Toronto",
      "MYT-Montreal",
    ]),
    ...overrides,
  };
}

describe("buildCreateJobOrderBody", () => {
  it("copies company address, defaults On-Site, and sets Internal Department from Sales Rep", async () => {
    const d = deps({
      findUserIdByExactEmail: vi.fn(async () => 65),
    });
    const body = await buildCreateJobOrderBody(
      {
        title: "Systems Engineer",
        clientCorporationId: 123,
        portalUserEmail: "agebara@myticas.com",
        additionalFields: {
          description: "Role Overview\n- Ship features\n- Own delivery",
        },
      },
      d,
    );

    expect(body.owner).toEqual({ id: 65 });
    expect(body.correlatedCustomText1).toBe("MYT-Ottawa");
    expect(body.onSite).toBe("On-Site");
    expect(body.address).toMatchObject({
      address1: "500 Palladium Dr",
      city: "Ottawa",
      countryName: "Canada",
    });
    expect(String(body.description)).toContain("<ul>");
    expect(String(body.description)).toContain("<li>");
    expect(body.publicDescription).toBe(body.description);
    expect(d.findUserIdByExactEmail).toHaveBeenCalledWith("agebara@myticas.com");
    expect(d.resolveSessionOwnerId).not.toHaveBeenCalled();
  });

  it("falls back to session owner when portal email does not match", async () => {
    const d = deps();
    const body = await buildCreateJobOrderBody(
      { title: "X", clientCorporationId: 1, portalUserEmail: "nobody@example.com" },
      d,
    );
    expect(body.owner).toEqual({ id: 99 });
    expect(d.resolveSessionOwnerId).toHaveBeenCalled();
  });

  it("honors explicit owner and correlatedCustomText1 overrides", async () => {
    const d = deps({
      findUserIdByExactEmail: vi.fn(async () => 65),
    });
    const body = await buildCreateJobOrderBody(
      {
        title: "X",
        clientCorporationId: 1,
        portalUserEmail: "agebara@myticas.com",
        additionalFields: {
          owner: { id: 12 },
          correlatedCustomText1: "MYT-Toronto",
        },
      },
      d,
    );
    expect(body.owner).toEqual({ id: 12 });
    expect(body.correlatedCustomText1).toBe("MYT-Toronto");
    expect(d.fetchUserPrimaryDepartmentName).not.toHaveBeenCalled();
    expect(d.findUserIdByExactEmail).not.toHaveBeenCalled();
  });

  it("keeps company address when onSite is Remote", async () => {
    const d = deps();
    const body = await buildCreateJobOrderBody(
      {
        title: "Remote Role",
        clientCorporationId: 1,
        additionalFields: { onSite: "remote" },
      },
      d,
    );
    expect(body.onSite).toBe("Remote");
    expect(body.isWorkFromHome).toBe(true);
    expect(body.address).toMatchObject({ city: "Ottawa" });
  });

  it("does not overwrite an explicit address", async () => {
    const d = deps();
    const body = await buildCreateJobOrderBody(
      {
        title: "X",
        clientCorporationId: 1,
        additionalFields: {
          address: { city: "Cairo", countryName: "Egypt" },
        },
      },
      d,
    );
    expect(body.address).toEqual({ city: "Cairo", countryName: "Egypt" });
    expect(d.fetchCompanyAddress).not.toHaveBeenCalled();
  });

  it("skips Internal Department when primary department is not a picklist option", async () => {
    const d = deps({
      fetchUserPrimaryDepartmentName: vi.fn(async () => "Unknown Dept"),
    });
    const body = await buildCreateJobOrderBody(
      { title: "X", clientCorporationId: 1 },
      d,
    );
    expect(body.correlatedCustomText1).toBeUndefined();
  });
});
