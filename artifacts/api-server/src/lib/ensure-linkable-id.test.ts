import { describe, it, expect } from "vitest";
import { ensureLinkableIdField } from "./bullhorn-client.js";

describe("ensureLinkableIdField", () => {
  it("prepends id for a linkable entity when the AI omits it", () => {
    expect(
      ensureLinkableIdField("ClientContact", "firstName,lastName,email"),
    ).toBe("id,firstName,lastName,email");
  });

  it("leaves fields untouched when id is already present", () => {
    expect(
      ensureLinkableIdField("ClientContact", "id,firstName,lastName,email"),
    ).toBe("id,firstName,lastName,email");
  });

  it("treats id case-insensitively (does not duplicate)", () => {
    expect(ensureLinkableIdField("Candidate", "ID,firstName")).toBe(
      "ID,firstName",
    );
    expect(ensureLinkableIdField("Candidate", "Id,firstName")).toBe(
      "Id,firstName",
    );
  });

  it("leaves '*' untouched (Bullhorn returns id with *)", () => {
    expect(ensureLinkableIdField("JobOrder", "*")).toBe("*");
  });

  it("is not fooled by a nested id in an association sub-selection", () => {
    expect(
      ensureLinkableIdField("ClientContact", "firstName,owner(id,name)"),
    ).toBe("id,firstName,owner(id,name)");
  });

  it("keeps balanced nested selections intact when id is already top-level", () => {
    expect(
      ensureLinkableIdField("Candidate", "id,primarySkills(id,name)"),
    ).toBe("id,primarySkills(id,name)");
  });

  it("is a no-op for non-linkable entities even without id", () => {
    expect(ensureLinkableIdField("Note", "comments,dateAdded")).toBe(
      "comments,dateAdded",
    );
    expect(ensureLinkableIdField("Task", "subject")).toBe("subject");
  });

  it("prepends id for every linkable entity type", () => {
    for (const entity of [
      "Candidate",
      "ClientContact",
      "ClientCorporation",
      "JobOrder",
      "JobSubmission",
      "Lead",
      "Opportunity",
      "Placement",
    ]) {
      expect(ensureLinkableIdField(entity, "name,status")).toBe(
        "id,name,status",
      );
    }
  });
});
