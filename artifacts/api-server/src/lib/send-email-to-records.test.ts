import { beforeEach, describe, expect, it, vi } from "vitest";

const previewEmailToRecord = vi.fn();
const sendEmailToRecord = vi.fn();
const getUserMailboxStatus = vi.fn();
const getMailboxConnectUrlForUser = vi.fn();

vi.mock("./send-email-to-record.js", () => ({
  previewEmailToRecord,
  sendEmailToRecord,
}));

vi.mock("./m365-auth.js", () => ({
  getUserMailboxStatus,
  getMailboxConnectUrlForUser,
}));

describe("send-email-to-records bulk orchestration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    const mod = await import("./send-email-to-records.js");
    mod.clearBulkEmailConfirmTokensForTests();
    return mod;
  }

  it("rejects more than BULK_EMAIL_MAX_RECIPIENTS", async () => {
    const { previewEmailsToRecords, BULK_EMAIL_MAX_RECIPIENTS } = await load();
    const recipients = Array.from({ length: BULK_EMAIL_MAX_RECIPIENTS + 1 }, (_, i) => ({
      entityType: "Candidate" as const,
      recordId: i + 1,
    }));

    const result = await previewEmailsToRecords({
      userId: "user-1",
      recipients,
      subject: "Hi",
      body: "Body",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "too_many_recipients",
      maxAllowed: BULK_EMAIL_MAX_RECIPIENTS,
    });
    expect(previewEmailToRecord).not.toHaveBeenCalled();
  });

  it("skips missing email / DNC and mints confirmToken for ready rows", async () => {
    previewEmailToRecord
      .mockResolvedValueOnce({
        ok: false,
        error: "missing_email",
        message: "no email",
        recipient: {
          entityType: "Candidate",
          recordId: 1,
          name: "No Email",
          email: null,
          status: "Active",
          bullhornUrl: null,
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "do_not_contact",
        message: "dnc",
        recipient: {
          entityType: "Candidate",
          recordId: 2,
          name: "DNC Person",
          email: "dnc@example.com",
          status: "Do Not Contact",
          bullhornUrl: null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        recipient: {
          entityType: "Candidate",
          recordId: 3,
          name: "Ready Person",
          email: "ready@example.com",
          status: "Active",
          bullhornUrl: "https://bh/3",
        },
      });
    getUserMailboxStatus.mockResolvedValue({
      connected: true,
      mailboxEmail: "recruiter@example.com",
    });

    const { previewEmailsToRecords } = await load();
    const result = await previewEmailsToRecords({
      userId: "user-1",
      recipients: [
        { entityType: "Candidate", recordId: 1 },
        { entityType: "Candidate", recordId: 2 },
        { entityType: "Candidate", recordId: 3 },
      ],
      subject: "Hello",
      body: "Body text",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readyCount).toBe(1);
    expect(result.skippedCount).toBe(2);
    expect(result.confirmToken).toMatch(/^[a-f0-9]{48}$/);
    expect(result.ready[0]?.recordId).toBe(3);
  });

  it("does not mint confirmToken when mailbox is disconnected", async () => {
    previewEmailToRecord.mockResolvedValue({
      ok: true,
      recipient: {
        entityType: "Candidate",
        recordId: 10,
        name: "Ready",
        email: "r@example.com",
        status: "Active",
        bullhornUrl: null,
      },
    });
    getUserMailboxStatus.mockResolvedValue({ connected: false, mailboxEmail: null });
    getMailboxConnectUrlForUser.mockResolvedValue("https://connect.example/m365");

    const { previewEmailsToRecords } = await load();
    const result = await previewEmailsToRecords({
      userId: "user-1",
      recipients: [{ entityType: "Candidate", recordId: 10 }],
      subject: "Hi",
      body: "Body",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confirmToken).toBeNull();
    expect(result.connectUrl).toContain("m365");
  });

  it("requires confirmToken for live send and rejects mismatches", async () => {
    previewEmailToRecord.mockResolvedValue({
      ok: true,
      recipient: {
        entityType: "Candidate",
        recordId: 5,
        name: "Ready",
        email: "r@example.com",
        status: "Active",
        bullhornUrl: null,
      },
    });
    getUserMailboxStatus.mockResolvedValue({
      connected: true,
      mailboxEmail: "recruiter@example.com",
    });

    const { previewEmailsToRecords, sendEmailsToRecords } = await load();
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients: [{ entityType: "Candidate", recordId: 5 }],
      subject: "Hi",
      body: "Body",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");

    const mismatch = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: { kind: "user", userId: "user-1" } as never,
      recipients: [{ entityType: "Candidate", recordId: 5 }],
      subject: "CHANGED",
      body: "Body",
      confirmToken: preview.confirmToken,
    });
    expect(mismatch).toMatchObject({ ok: false, error: "confirm_mismatch" });
    expect(sendEmailToRecord).not.toHaveBeenCalled();
  });

  it("sends serially to ready recipients after a valid confirm", async () => {
    previewEmailToRecord
      .mockResolvedValueOnce({
        ok: true,
        recipient: {
          entityType: "Candidate",
          recordId: 1,
          name: "One",
          email: "one@example.com",
          status: "Active",
          bullhornUrl: "https://bh/1",
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "missing_email",
        message: "no email",
        recipient: {
          entityType: "Candidate",
          recordId: 2,
          name: "Two",
          email: null,
          status: "Active",
          bullhornUrl: null,
        },
      });
    getUserMailboxStatus.mockResolvedValue({
      connected: true,
      mailboxEmail: "recruiter@example.com",
    });
    sendEmailToRecord.mockResolvedValue({
      ok: true,
      entityType: "Candidate",
      recordId: 1,
      recipient: {
        entityType: "Candidate",
        recordId: 1,
        name: "One",
        email: "one@example.com",
        status: "Active",
        bullhornUrl: "https://bh/1",
      },
      senderEmail: "recruiter@example.com",
      subject: "Hi",
      logId: "log-1",
      bullhornNoteId: 99,
    });

    const { previewEmailsToRecords, sendEmailsToRecords } = await load();
    const recipients = [
      { entityType: "Candidate" as const, recordId: 1 },
      { entityType: "Candidate" as const, recordId: 2 },
    ];
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients,
      subject: "Hi",
      body: "Body",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");

    const sent = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: { kind: "user", userId: "user-1" } as never,
      recipients,
      subject: "Hi",
      body: "Body",
      confirmToken: preview.confirmToken,
    });

    expect(sent).toMatchObject({
      ok: true,
      sentCount: 1,
      failedCount: 0,
      skippedCount: 0,
      stoppedEarly: false,
    });
    expect(sendEmailToRecord).toHaveBeenCalledTimes(1);
    expect(sendEmailToRecord).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 1, subject: "Hi" }),
    );
  });

  it("skips recipients that fail to resolve instead of aborting the batch", async () => {
    previewEmailToRecord
      .mockRejectedValueOnce(new Error("Bullhorn API error (404): Entity not found."))
      .mockResolvedValueOnce({
        ok: true,
        recipient: {
          entityType: "Candidate",
          recordId: 3,
          name: "Ready Person",
          email: "ready@example.com",
          status: "Active",
          bullhornUrl: "https://bh/3",
        },
      });
    getUserMailboxStatus.mockResolvedValue({
      connected: true,
      mailboxEmail: "recruiter@example.com",
    });

    const { previewEmailsToRecords } = await load();
    const result = await previewEmailsToRecords({
      userId: "user-1",
      recipients: [
        { entityType: "Candidate", recordId: 1 },
        { entityType: "Candidate", recordId: 3 },
      ],
      subject: "Hello",
      body: "Body text",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readyCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped[0]).toMatchObject({
      recordId: 1,
      error: "resolve_failed",
    });
    expect(result.confirmToken).toBeTruthy();
  });

  it("stops early on mailbox reconnect failure and does not continue", async () => {
    previewEmailToRecord
      .mockResolvedValueOnce({
        ok: true,
        recipient: {
          entityType: "Candidate",
          recordId: 1,
          name: "One",
          email: "one@example.com",
          status: "Active",
          bullhornUrl: null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        recipient: {
          entityType: "Candidate",
          recordId: 2,
          name: "Two",
          email: "two@example.com",
          status: "Active",
          bullhornUrl: null,
        },
      });
    getUserMailboxStatus.mockResolvedValue({
      connected: true,
      mailboxEmail: "recruiter@example.com",
    });
    sendEmailToRecord.mockResolvedValueOnce({
      ok: false,
      error: "mailbox_reconnect_required",
      message: "reconnect",
      connectUrl: "https://connect.example/m365",
      recipient: {
        entityType: "Candidate",
        recordId: 1,
        name: "One",
        email: "one@example.com",
        status: "Active",
        bullhornUrl: null,
      },
    });

    const { previewEmailsToRecords, sendEmailsToRecords } = await load();
    const recipients = [
      { entityType: "Candidate" as const, recordId: 1 },
      { entityType: "Candidate" as const, recordId: 2 },
    ];
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients,
      subject: "Hi",
      body: "Body",
    });
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");

    const result = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: { kind: "user", userId: "user-1" } as never,
      recipients,
      subject: "Hi",
      body: "Body",
      confirmToken: preview.confirmToken,
    });

    expect(result).toMatchObject({
      ok: true,
      sentCount: 0,
      failedCount: 1,
      stoppedEarly: true,
      stopReason: "mailbox_reconnect_required",
    });
    expect(sendEmailToRecord).toHaveBeenCalledTimes(1);
  });
});
