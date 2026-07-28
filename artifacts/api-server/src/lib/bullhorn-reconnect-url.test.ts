import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  },
  usersTable: { id: "id" },
}));

vi.mock("./getBaseUrl.js", () => ({
  getBaseUrl: () => "https://connect.asktoact.ai",
}));

import { BullhornReconnectRequiredError, getBullhornReconnectUrlForUser } from "./bullhorn-auth.js";
import { db } from "@workspace/db";

describe("Bullhorn reconnect URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints an absolute enroll?token= URL (never enroll?id=)", async () => {
    const url = await getBullhornReconnectUrlForUser("user-123");
    expect(url).toMatch(
      /^https:\/\/connect\.asktoact\.ai\/api\/auth\/user\/enroll\?token=[a-f0-9]{64}$/,
    );
    expect(url).not.toContain("enroll?id=");
    expect(db.update).toHaveBeenCalled();
  });

  it("carries the reconnect URL on BullhornReconnectRequiredError", () => {
    const err = new BullhornReconnectRequiredError(
      "https://connect.asktoact.ai/api/auth/user/enroll?token=abc",
    );
    expect(err.name).toBe("BullhornReconnectRequiredError");
    expect(err.connectUrl).toContain("/api/auth/user/enroll?token=");
    expect(err.message).toMatch(/reconnect/i);
  });
});
