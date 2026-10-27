import { beforeEach, describe, expect, it, vi } from "vitest";

// Locks resolveDeptField: per-firm discovered names win, unsafe stored names
// become null (never the Myticas fallback), and the in-memory cache stays
// per firm. No live Bullhorn or database.

const dbState = vi.hoisted(() => ({
  maps: new Map<string, unknown>(),
  throwOnLoad: false,
  selectCount: 0,
}));

vi.mock("drizzle-orm", () => ({
  eq: (_column: unknown, value: unknown) => ({ firmId: value }),
}));

vi.mock("@workspace/db", () => ({
  firmConfigTable: { firmId: "firmId", fieldMap: "fieldMap" },
  db: {
    select: () => ({
      from: () => ({
        where: (pred: { firmId?: unknown }) => ({
          limit: async () => {
            dbState.selectCount += 1;
            if (dbState.throwOnLoad) {
              throw new Error("field map unavailable");
            }
            const firmId = pred.firmId;
            if (typeof firmId !== "string" || !dbState.maps.has(firmId))
              return [];
            return [{ fieldMap: dbState.maps.get(firmId) }];
          },
        }),
      }),
    }),
  },
}));

vi.mock("./bullhorn-auth.js", () => ({
  firmContext: { run: async (_ctx: unknown, fn: () => unknown) => fn() },
  getFirmAuthMode: vi.fn(async () => "oauth"),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "./logger.js";
import { invalidateFirmConfigCache, resolveDeptField } from "./firm-config.js";

const MYTICAS_DEPT_FIELDS = {
  JobOrder: "correlatedCustomText1",
  Placement: "correlatedCustomText1",
  Candidate: "customText3",
  ClientContact: "customText1",
  Lead: "customText1",
  Opportunity: "customText1",
} as const;

function fieldMap(internalDepartment: Record<string, string>) {
  return {
    version: 1,
    entities: {},
    semantics: { internalDepartment },
    missing: { internalDepartment: [] as string[] },
  };
}

beforeEach(() => {
  dbState.maps.clear();
  dbState.throwOnLoad = false;
  dbState.selectCount = 0;
  invalidateFirmConfigCache();
  vi.clearAllMocks();
});

describe("resolveDeptField", () => {
  it("uses the Myticas fallback when there is no firm id", async () => {
    dbState.maps.set("firm-a", fieldMap({ JobOrder: "customText5" }));

    for (const [entity, field] of Object.entries(MYTICAS_DEPT_FIELDS)) {
      await expect(resolveDeptField(null, entity)).resolves.toBe(field);
    }
    await expect(resolveDeptField(null, "UnknownEntity")).resolves.toBeNull();
    expect(dbState.selectCount).toBe(0);
  });

  it("uses the Myticas fallback when the firm has no config row", async () => {
    for (const [entity, field] of Object.entries(MYTICAS_DEPT_FIELDS)) {
      await expect(resolveDeptField("firm-none", entity)).resolves.toBe(field);
    }
    await expect(
      resolveDeptField("firm-none", "UnknownEntity"),
    ).resolves.toBeNull();
    expect(dbState.selectCount).toBe(1);
  });

  it("uses the Myticas fallback when the map has no entry for that entity", async () => {
    dbState.maps.set("firm-partial", fieldMap({ Candidate: "customText9" }));

    await expect(resolveDeptField("firm-partial", "JobOrder")).resolves.toBe(
      "correlatedCustomText1",
    );
    await expect(resolveDeptField("firm-partial", "Placement")).resolves.toBe(
      "correlatedCustomText1",
    );
    await expect(
      resolveDeptField("firm-partial", "ClientContact"),
    ).resolves.toBe("customText1");
    await expect(resolveDeptField("firm-partial", "Lead")).resolves.toBe(
      "customText1",
    );
    await expect(resolveDeptField("firm-partial", "Opportunity")).resolves.toBe(
      "customText1",
    );
    await expect(
      resolveDeptField("firm-partial", "UnknownEntity"),
    ).resolves.toBeNull();
    await expect(resolveDeptField("firm-partial", "Candidate")).resolves.toBe(
      "customText9",
    );
  });

  it("returns a stored name that matches the safe field pattern", async () => {
    dbState.maps.set(
      "firm-stored",
      fieldMap({
        JobOrder: "customText5",
        Placement: "customText6",
        Candidate: "customText7",
        ClientContact: "customText8",
        Lead: "customText9",
        Opportunity: "customText10",
      }),
    );

    await expect(resolveDeptField("firm-stored", "JobOrder")).resolves.toBe(
      "customText5",
    );
    await expect(resolveDeptField("firm-stored", "Placement")).resolves.toBe(
      "customText6",
    );
    await expect(resolveDeptField("firm-stored", "Candidate")).resolves.toBe(
      "customText7",
    );
    await expect(
      resolveDeptField("firm-stored", "ClientContact"),
    ).resolves.toBe("customText8");
    await expect(resolveDeptField("firm-stored", "Lead")).resolves.toBe(
      "customText9",
    );
    await expect(resolveDeptField("firm-stored", "Opportunity")).resolves.toBe(
      "customText10",
    );
  });

  it.each([
    ["space", "custom Text"],
    ["quote", 'custom"Text'],
    ["parenthesis", "customText(1)"],
    ["leading digit", "1customText"],
    // Empty string is present, so `??` must not replace it with the Myticas field.
    ["empty string", ""],
  ])("returns null for a stored name with a %s", async (_label, stored) => {
    dbState.maps.set("firm-unsafe", fieldMap({ JobOrder: stored }));

    await expect(
      resolveDeptField("firm-unsafe", "JobOrder"),
    ).resolves.toBeNull();
  });

  it("logs a field-map load error and uses the Myticas fallback", async () => {
    dbState.throwOnLoad = true;

    for (const [entity, field] of Object.entries(MYTICAS_DEPT_FIELDS)) {
      await expect(resolveDeptField("firm-load-error", entity)).resolves.toBe(
        field,
      );
    }
    await expect(
      resolveDeptField("firm-load-error", "UnknownEntity"),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        firmId: "firm-load-error",
        entity: "JobOrder",
        err: expect.any(Error),
      }),
      "firm-config: field-map load failed; using fallback",
    );
    expect(dbState.selectCount).toBe(
      Object.keys(MYTICAS_DEPT_FIELDS).length + 1,
    );
  });

  it("does not return one firm's cached map for another firm", async () => {
    dbState.maps.set("firm-a", fieldMap({ JobOrder: "customText5" }));
    dbState.maps.set("firm-b", fieldMap({ JobOrder: "customText8" }));

    await expect(resolveDeptField("firm-a", "JobOrder")).resolves.toBe(
      "customText5",
    );
    await expect(resolveDeptField("firm-b", "JobOrder")).resolves.toBe(
      "customText8",
    );

    dbState.maps.set("firm-a", fieldMap({ JobOrder: "customText1" }));
    dbState.maps.set("firm-b", fieldMap({ JobOrder: "customText2" }));

    await expect(resolveDeptField("firm-a", "JobOrder")).resolves.toBe(
      "customText5",
    );
    await expect(resolveDeptField("firm-b", "JobOrder")).resolves.toBe(
      "customText8",
    );
    expect(dbState.selectCount).toBe(2);
  });

  it("keeps a cached null until that firm is invalidated", async () => {
    await expect(resolveDeptField("firm-a", "JobOrder")).resolves.toBe(
      "correlatedCustomText1",
    );
    dbState.maps.set("firm-b", fieldMap({ JobOrder: "customText8" }));
    await expect(resolveDeptField("firm-b", "JobOrder")).resolves.toBe(
      "customText8",
    );
    expect(dbState.selectCount).toBe(2);

    dbState.maps.set("firm-a", fieldMap({ JobOrder: "customText5" }));
    dbState.maps.set("firm-b", fieldMap({ JobOrder: "customText9" }));

    await expect(resolveDeptField("firm-a", "JobOrder")).resolves.toBe(
      "correlatedCustomText1",
    );
    await expect(resolveDeptField("firm-b", "JobOrder")).resolves.toBe(
      "customText8",
    );
    expect(dbState.selectCount).toBe(2);

    invalidateFirmConfigCache("firm-a");

    await expect(resolveDeptField("firm-a", "JobOrder")).resolves.toBe(
      "customText5",
    );
    await expect(resolveDeptField("firm-b", "JobOrder")).resolves.toBe(
      "customText8",
    );
    expect(dbState.selectCount).toBe(3);
  });

  it("drops the whole cache when invalidated with no firm id", async () => {
    await expect(resolveDeptField("firm-a", "Candidate")).resolves.toBe(
      "customText3",
    );
    dbState.maps.set("firm-b", fieldMap({ Candidate: "customText7" }));
    await expect(resolveDeptField("firm-b", "Candidate")).resolves.toBe(
      "customText7",
    );

    dbState.maps.set("firm-a", fieldMap({ Candidate: "customText4" }));
    dbState.maps.set("firm-b", fieldMap({ Candidate: "customText9" }));
    invalidateFirmConfigCache();

    await expect(resolveDeptField("firm-a", "Candidate")).resolves.toBe(
      "customText4",
    );
    await expect(resolveDeptField("firm-b", "Candidate")).resolves.toBe(
      "customText9",
    );
    expect(dbState.selectCount).toBe(4);
  });
});
