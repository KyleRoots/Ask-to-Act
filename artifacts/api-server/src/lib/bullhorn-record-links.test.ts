import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UI_LINKABLE_ENTITIES,
  bullhornUrlForEntity,
  enrichWithProfileUrls,
} from "./bullhorn-client.js";

vi.mock("./bullhorn-auth.js", () => ({
  getSession: vi.fn(async () => {
    throw new Error("no bullhorn session");
  }),
  invalidateSession: vi.fn(),
  currentFirmContextId: () => null,
}));

const ORIGINAL_UI_BASE = process.env.BULLHORN_UI_BASE_URL;

afterEach(() => {
  if (ORIGINAL_UI_BASE === undefined) delete process.env.BULLHORN_UI_BASE_URL;
  else process.env.BULLHORN_UI_BASE_URL = ORIGINAL_UI_BASE;
});

describe("bullhornUrlForEntity", () => {
  it("uses the Novo open-window URL for every linkable entity", () => {
    delete process.env.BULLHORN_UI_BASE_URL;
    for (const entity of UI_LINKABLE_ENTITIES) {
      expect(bullhornUrlForEntity(entity, 36144)).toBe(
        `https://app.bullhornstaffing.com/openwindow?entity=${entity}&id=36144`,
      );
    }
  });

  it("honors BULLHORN_UI_BASE_URL and trims trailing slashes", () => {
    process.env.BULLHORN_UI_BASE_URL = "https://bullhorn.example.com/app///";
    expect(bullhornUrlForEntity("Candidate", 42)).toBe(
      "https://bullhorn.example.com/app/openwindow?entity=Candidate&id=42",
    );
  });

  it("returns null for non-linkable entities and bad ids", () => {
    delete process.env.BULLHORN_UI_BASE_URL;
    expect(bullhornUrlForEntity("Note", 10)).toBeNull();
    expect(bullhornUrlForEntity("Task", 10)).toBeNull();
    expect(bullhornUrlForEntity("Candidate", 0)).toBeNull();
    expect(bullhornUrlForEntity("Candidate", -5)).toBeNull();
    expect(bullhornUrlForEntity("Candidate", Number.NaN)).toBeNull();
    expect(bullhornUrlForEntity("Candidate", Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("still builds a link when no session restUrl is available", () => {
    delete process.env.BULLHORN_UI_BASE_URL;
    expect(bullhornUrlForEntity("JobOrder", 36144)).toBe(
      "https://app.bullhornstaffing.com/openwindow?entity=JobOrder&id=36144",
    );
  });
});

describe("enrichWithProfileUrls", () => {
  it("adds links on a list envelope and on a bare record without a session", async () => {
    delete process.env.BULLHORN_UI_BASE_URL;
    const list = await enrichWithProfileUrls("Candidate", {
      total: 2,
      data: [
        { id: 4684293, firstName: "Ada" },
        { id: 0, firstName: "Skip" },
        { firstName: "NoId" },
      ],
    });
    const rows = (list as { data: Array<{ bullhornUrl?: string }> }).data;
    expect(rows[0].bullhornUrl).toBe(
      "https://app.bullhornstaffing.com/openwindow?entity=Candidate&id=4684293",
    );
    expect(rows[1].bullhornUrl).toBeUndefined();
    expect(rows[2].bullhornUrl).toBeUndefined();

    const bare = (await enrichWithProfileUrls("ClientContact", {
      id: 99,
      name: "Pat",
    })) as { bullhornUrl?: string };
    expect(bare.bullhornUrl).toBe(
      "https://app.bullhornstaffing.com/openwindow?entity=ClientContact&id=99",
    );
  });

  it("leaves non-linkable payloads unchanged", async () => {
    const note = { id: 7, comments: "hi" };
    expect(await enrichWithProfileUrls("Note", note)).toBe(note);
    expect(note).not.toHaveProperty("bullhornUrl");
  });
});
