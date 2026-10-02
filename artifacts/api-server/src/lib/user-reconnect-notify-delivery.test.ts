import { beforeEach, describe, expect, it, vi } from "vitest";

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const select = vi.fn(() => ({ from: selectFrom }));
const updateWhere = vi.fn();
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));

const claimReconnectNotice = vi.fn();
const completeReconnectNotice = vi.fn();
const currentRefreshGeneration = vi.fn();
const sendReconnectEmail = vi.fn();

vi.mock("@workspace/db", () => ({
  db: { select, update },
  usersTable: {
    id: "users.id",
    name: "users.name",
    email: "users.email",
    firmId: "users.firm_id",
    reconnectEmailSentAt: "users.reconnect_email_sent_at",
    updatedAt: "users.updated_at",
  },
  firmsTable: {
    id: "firms.id",
    name: "firms.name",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => "eq"),
  sql: vi.fn(() => "sql"),
}));

vi.mock("./bullhorn-refresh-coordinator.js", () => ({
  claimReconnectNotice,
  completeReconnectNotice,
  currentRefreshGeneration,
}));

vi.mock("./emailService.js", () => ({
  sendReconnectEmail,
}));

const { maybeSendUserReconnectEmail } = await import("./user-reconnect-notify.js");

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([
    {
      id: "user-1",
      name: "Ada",
      email: "ada@example.com",
      firmId: null,
      reconnectEmailSentAt: null,
    },
  ]);
  currentRefreshGeneration.mockResolvedValue(12);
  claimReconnectNotice.mockResolvedValue(true);
  completeReconnectNotice.mockResolvedValue(true);
  sendReconnectEmail.mockResolvedValue(undefined);
  updateWhere.mockResolvedValue({ rowCount: 1 });
});

describe("maybeSendUserReconnectEmail delivery states", () => {
  it("claims before sending and marks accepted after mailer success", async () => {
    await expect(
      maybeSendUserReconnectEmail({
        userId: "user-1",
        connectUrl: "https://connect.example/reconnect",
        expectedGeneration: 12,
        nowMs: Date.parse("2026-10-02T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ sent: true, state: "accepted" });

    expect(claimReconnectNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "user",
        id: "user-1",
        expectedGeneration: 12,
      }),
    );
    expect(sendReconnectEmail).toHaveBeenCalledTimes(1);
    expect(completeReconnectNotice).toHaveBeenCalledWith(
      expect.objectContaining({ state: "accepted", expectedGeneration: 12 }),
    );
  });

  it("does not send when another notice already claimed the generation", async () => {
    claimReconnectNotice.mockResolvedValue(false);

    await expect(
      maybeSendUserReconnectEmail({
        userId: "user-1",
        connectUrl: "https://connect.example/reconnect",
        expectedGeneration: 12,
      }),
    ).resolves.toMatchObject({ sent: false, skippedReason: "not_claimed" });

    expect(sendReconnectEmail).not.toHaveBeenCalled();
  });

  it("marks failed when the mailer rejects", async () => {
    sendReconnectEmail.mockRejectedValue(new Error("mailer down"));

    await expect(
      maybeSendUserReconnectEmail({
        userId: "user-1",
        connectUrl: "https://connect.example/reconnect",
        expectedGeneration: 12,
      }),
    ).resolves.toMatchObject({ sent: false, state: "failed", skippedReason: "send_failed" });

    expect(completeReconnectNotice).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed", error: "mailer down" }),
    );
  });

  it("reports unknown when mailer accepted but completion was superseded", async () => {
    completeReconnectNotice.mockResolvedValue(false);

    await expect(
      maybeSendUserReconnectEmail({
        userId: "user-1",
        connectUrl: "https://connect.example/reconnect",
        expectedGeneration: 12,
      }),
    ).resolves.toMatchObject({
      sent: true,
      state: "unknown",
      skippedReason: "completion_superseded",
    });
  });
});
