import { describe, it, expect } from "vitest";
import {
  validateWriteFields,
  softDeleteEntity,
  restoreEntity,
  archiveOrCancelPlacement,
  BullhornFieldValidationError,
  SOFT_DELETABLE_ENTITIES,
  type BullhornWriteSession,
} from "./bullhorn-client.js";

// ---------------------------------------------------------------------------
// Soft-delete safety rails.
//
// Every assertion here exercises a guard that fires BEFORE any Bullhorn call,
// so no network/mocking is needed: the isDeleted rejection in
// validateWriteFields and the entity allowlist in the soft-delete helpers are
// deterministic local checks.
// ---------------------------------------------------------------------------

const fakeSession: BullhornWriteSession = {
  BhRestToken: "test-token",
  restUrl: "https://rest.example.invalid/rest-services/xyz/",
};

describe("validateWriteFields blocks isDeleted on generic writes", () => {
  it("rejects isDeleted:true on update and points to delete_entity", async () => {
    await expect(
      validateWriteFields("Candidate", { isDeleted: true }, { mode: "update" }),
    ).rejects.toThrow(BullhornFieldValidationError);
    await expect(
      validateWriteFields("Candidate", { isDeleted: true }, { mode: "update" }),
    ).rejects.toThrow(/delete_entity/);
  });

  it("rejects isDeleted regardless of key casing", async () => {
    await expect(
      validateWriteFields("JobOrder", { isdeleted: true }, { mode: "update" }),
    ).rejects.toThrow(BullhornFieldValidationError);
    await expect(
      validateWriteFields("JobOrder", { ISDELETED: false }, { mode: "update" }),
    ).rejects.toThrow(BullhornFieldValidationError);
  });

  it("rejects isDeleted on create too (even isDeleted:false)", async () => {
    await expect(
      validateWriteFields("Lead", { firstName: "A", isDeleted: false }, { mode: "create" }),
    ).rejects.toThrow(/restore_entity|delete_entity/);
  });
});

describe("soft-delete helper entity allowlist", () => {
  it("covers exactly the major entities agreed in scope", () => {
    expect([...SOFT_DELETABLE_ENTITIES].sort()).toEqual(
      [
        "Candidate",
        "ClientContact",
        "ClientCorporation",
        "JobOrder",
        "JobSubmission",
        "Lead",
        "Opportunity",
      ].sort(),
    );
  });

  it("rejects Placement with a pointer to archive_placement", async () => {
    await expect(softDeleteEntity(fakeSession, "Placement", 1)).rejects.toThrow(
      /archive_placement/,
    );
    await expect(restoreEntity(fakeSession, "Placement", 1)).rejects.toThrow(
      /archive_placement/,
    );
  });

  it("rejects non-deletable entities like Note and Task", async () => {
    await expect(softDeleteEntity(fakeSession, "Note", 1)).rejects.toThrow(
      BullhornFieldValidationError,
    );
    await expect(softDeleteEntity(fakeSession, "Task", 1)).rejects.toThrow(
      /Only these entities can be soft-deleted/,
    );
  });

  it("rejects unknown entity types with the supported-entities message", async () => {
    await expect(softDeleteEntity(fakeSession, "NotARealEntity", 1)).rejects.toThrow(
      /Unknown or unsupported entityType/,
    );
  });
});

describe("archiveOrCancelPlacement input guard", () => {
  it("requires a non-empty target status", async () => {
    await expect(archiveOrCancelPlacement(fakeSession, 1, "")).rejects.toThrow(
      /list_field_options/,
    );
    await expect(archiveOrCancelPlacement(fakeSession, 1, "   ")).rejects.toThrow(
      BullhornFieldValidationError,
    );
  });
});
