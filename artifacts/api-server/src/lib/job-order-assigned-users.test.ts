import { describe, it, expect, vi } from "vitest";
import {
  applyJobOrderAssignedUsers,
  parseAssignedUsersWrite,
  stripAssignedUsersFromFields,
  type AssignedUsersWriteSession,
} from "./job-order-assigned-users.js";

const fakeSession: AssignedUsersWriteSession = {
  BhRestToken: "test-token",
  restUrl: "https://rest.example.invalid/rest-services/xyz/",
};

describe("parseAssignedUsersWrite", () => {
  it("parses [{ id }] arrays as add-only", () => {
    expect(parseAssignedUsersWrite([{ id: 65 }])).toEqual({
      add: [65],
      remove: [],
    });
    expect(parseAssignedUsersWrite([{ id: 65 }, { id: 66 }])).toEqual({
      add: [65, 66],
      remove: [],
    });
  });

  it("parses raw numeric id arrays", () => {
    expect(parseAssignedUsersWrite([65, 66])).toEqual({
      add: [65, 66],
      remove: [],
    });
  });

  it("parses Bullhorn add/remove wrapper objects", () => {
    expect(parseAssignedUsersWrite({ add: [65], remove: [12] })).toEqual({
      add: [65],
      remove: [12],
    });
    expect(parseAssignedUsersWrite({ add: [{ id: 65 }] })).toEqual({
      add: [65],
      remove: [],
    });
  });

  it("dedupes ids and ignores invalid entries", () => {
    expect(parseAssignedUsersWrite([{ id: 65 }, { id: 65 }, { id: 0 }, {}])).toEqual({
      add: [65],
      remove: [],
    });
  });

  it("returns null for empty or unparseable values", () => {
    expect(parseAssignedUsersWrite(undefined)).toBeNull();
    expect(parseAssignedUsersWrite([])).toBeNull();
    expect(parseAssignedUsersWrite({})).toBeNull();
    expect(parseAssignedUsersWrite("65")).toBeNull();
  });
});

describe("stripAssignedUsersFromFields", () => {
  it("removes assignedUsers case-insensitively and preserves other fields", () => {
    const { fields, assignedUsers } = stripAssignedUsersFromFields({
      status: "Accepting Candidates",
      AssignedUsers: [{ id: 65 }],
    });
    expect(fields).toEqual({ status: "Accepting Candidates" });
    expect(assignedUsers).toEqual({ add: [65], remove: [] });
  });
});

describe("applyJobOrderAssignedUsers", () => {
  it("DELETEs removals then PUTs additions via association paths", async () => {
    const writeFetch = vi.fn(async () => ({}));
    const result = await applyJobOrderAssignedUsers(
      fakeSession,
      35783,
      { add: [65, 66], remove: [12] },
      writeFetch,
    );

    expect(result).toEqual({ added: [65, 66], removed: [12] });
    expect(writeFetch).toHaveBeenCalledTimes(2);
    expect(writeFetch).toHaveBeenNthCalledWith(
      1,
      fakeSession,
      "DELETE",
      "entity/JobOrder/35783/assignedUsers/12",
      undefined,
    );
    expect(writeFetch).toHaveBeenNthCalledWith(
      2,
      fakeSession,
      "PUT",
      "entity/JobOrder/35783/assignedUsers/65,66",
      undefined,
    );
  });

  it("skips network calls when add and remove are empty", async () => {
    const writeFetch = vi.fn(async () => ({}));
    const result = await applyJobOrderAssignedUsers(
      fakeSession,
      1,
      { add: [], remove: [] },
      writeFetch,
    );
    expect(result).toEqual({ added: [], removed: [] });
    expect(writeFetch).not.toHaveBeenCalled();
  });
});
