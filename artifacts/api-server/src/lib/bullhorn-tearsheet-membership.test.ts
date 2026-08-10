import { describe, it, expect } from "vitest";
import {
  addRecordsToTearsheet,
  removeRecordsFromTearsheet,
  BullhornFieldValidationError,
  TEARSHEET_MEMBER_ENTITIES,
  type BullhornWriteSession,
} from "./bullhorn-client.js";

// ---------------------------------------------------------------------------
// Tearsheet multi-entity membership guards.
//
// These assertions fire BEFORE any Bullhorn call (empty ids / unsupported
// entityType), so no network or mocking is required.
// ---------------------------------------------------------------------------

const fakeSession: BullhornWriteSession = {
  BhRestToken: "test-token",
  restUrl: "https://rest.example.invalid/rest-services/xyz/",
};

describe("TEARSHEET_MEMBER_ENTITIES allowlist", () => {
  it("covers exactly the Tearsheet TO_MANY shortlist associations from meta", () => {
    expect([...TEARSHEET_MEMBER_ENTITIES].sort()).toEqual(
      ["Candidate", "ClientContact", "JobOrder", "Lead", "Opportunity"].sort(),
    );
  });
});

describe("addRecordsToTearsheet / removeRecordsFromTearsheet input guards", () => {
  it("rejects empty ids before any network call", async () => {
    await expect(addRecordsToTearsheet(fakeSession, 1, "Candidate", [])).rejects.toThrow(
      BullhornFieldValidationError,
    );
    await expect(removeRecordsFromTearsheet(fakeSession, 1, "ClientContact", [])).rejects.toThrow(
      /No ids provided/,
    );
  });

  it("rejects non-membership entities (users / recipients / Note / Placement)", async () => {
    await expect(addRecordsToTearsheet(fakeSession, 1, "CorporateUser", [1])).rejects.toThrow(
      /not supported/,
    );
    await expect(addRecordsToTearsheet(fakeSession, 1, "Note", [1])).rejects.toThrow(
      BullhornFieldValidationError,
    );
    await expect(removeRecordsFromTearsheet(fakeSession, 1, "Placement", [1])).rejects.toThrow(
      /Supported entity types/,
    );
  });

  it("rejects unknown entity types", async () => {
    await expect(addRecordsToTearsheet(fakeSession, 1, "NotARealEntity", [1])).rejects.toThrow(
      /Unknown or unsupported entityType/,
    );
  });
});
