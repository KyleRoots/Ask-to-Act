import { beforeEach, describe, expect, it, vi } from "vitest";

const previewEmailToRecord = vi.fn();
const deliverPreparedEmail = vi.fn();
const getUserMailboxStatus = vi.fn();
const getMailboxConnectUrlForUser = vi.fn();

vi.mock("./send-email-to-record.js", () => ({
  previewEmailToRecord,
  deliverPreparedEmail,
}));

vi.mock("./m365-auth.js", () => ({
  getUserMailboxStatus,
  getMailboxConnectUrlForUser,
}));

function ready(
  recordId: number,
  name: string,
  email: string,
  opts: {
    bullhornUrl?: string | null;
    subject?: string;
    body?: string;
    mergeValues?: Record<string, string | null>;
    usedFallback?: boolean;
  } = {},
) {
  return {
    ok: true,
    recipient: {
      entityType: "Candidate",
      recordId,
      name,
      email,
      status: "Active",
      bullhornUrl: opts.bullhornUrl ?? null,
    },
    subject: opts.subject ?? "Hi",
    renderedBody: opts.body ?? "Body",
    mergeValues: opts.mergeValues ?? {},
    usedFallback: opts.usedFallback ?? false,
  };
}

function skippedPreview(
  recordId: number,
  error: string,
  name: string,
  email: string | null,
  status = "Active",
) {
  return {
    ok: false,
    error,
    message: error,
    recipient: {
      entityType: "Candidate",
      recordId,
      name,
      email,
      status,
      bullhornUrl: null,
    },
  };
}

function delivered(recordId: number, name: string, email: string) {
  return {
    ok: true,
    entityType: "Candidate",
    recordId,
    recipient: {
      entityType: "Candidate",
      recordId,
      name,
      email,
      status: "Active",
      bullhornUrl: null,
    },
    senderEmail: "recruiter@example.com",
    subject: "Hi",
    logId: `log-${recordId}`,
    bullhornNoteId: 90 + recordId,
  };
}

const SESSION = { kind: "user", userId: "user-1" } as never;

describe("send-email-to-records bulk orchestration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getUserMailboxStatus.mockResolvedValue({
      connected: true,
      mailboxEmail: "recruiter@example.com",
    });
  });

  async function load() {
    const mod = await import("./send-email-to-records.js");
    mod.clearBulkEmailConfirmTokensForTests();
    return mod;
  }

  it("rejects more than BULK_EMAIL_MAX_RECIPIENTS", async () => {
    const { previewEmailsToRecords, BULK_EMAIL_MAX_RECIPIENTS } = await load();
    const recipients = Array.from(
      { length: BULK_EMAIL_MAX_RECIPIENTS + 1 },
      (_, i) => ({
        entityType: "Candidate" as const,
        recordId: i + 1,
      }),
    );

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
      .mockResolvedValueOnce(
        skippedPreview(1, "missing_email", "No Email", null),
      )
      .mockResolvedValueOnce(
        skippedPreview(
          2,
          "do_not_contact",
          "DNC Person",
          "dnc@example.com",
          "Do Not Contact",
        ),
      )
      .mockResolvedValueOnce(
        ready(3, "Ready Person", "ready@example.com", {
          bullhornUrl: "https://bh/3",
        }),
      );

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
    previewEmailToRecord.mockResolvedValue(ready(10, "Ready", "r@example.com"));
    getUserMailboxStatus.mockResolvedValue({
      connected: false,
      mailboxEmail: null,
    });
    getMailboxConnectUrlForUser.mockResolvedValue(
      "https://connect.example/m365",
    );

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

  it("requires confirmToken for live send and rejects a changed subject", async () => {
    previewEmailToRecord.mockResolvedValue(ready(5, "Ready", "r@example.com"));

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
      bullhornSession: SESSION,
      recipients: [{ entityType: "Candidate", recordId: 5 }],
      subject: "CHANGED",
      body: "Body",
      confirmToken: preview.confirmToken,
    });
    expect(mismatch).toMatchObject({ ok: false, error: "confirm_mismatch" });
    expect(deliverPreparedEmail).not.toHaveBeenCalled();
  });

  it("sends serially to ready recipients after a valid confirm", async () => {
    previewEmailToRecord.mockImplementation(
      async ({ recordId }: { recordId: number }) =>
        recordId === 1
          ? ready(1, "One", "one@example.com", { bullhornUrl: "https://bh/1" })
          : skippedPreview(2, "missing_email", "Two", null),
    );
    deliverPreparedEmail.mockResolvedValue(
      delivered(1, "One", "one@example.com"),
    );

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
      bullhornSession: SESSION,
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
    expect(deliverPreparedEmail).toHaveBeenCalledTimes(1);
    expect(deliverPreparedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        prepared: expect.objectContaining({
          subject: "Hi",
          recipient: expect.objectContaining({ recordId: 1 }),
        }),
      }),
    );
  });

  it("skips recipients that fail to resolve instead of aborting the batch", async () => {
    previewEmailToRecord
      .mockRejectedValueOnce(
        new Error("Bullhorn API error (404): Entity not found."),
      )
      .mockResolvedValueOnce(
        ready(3, "Ready Person", "ready@example.com", {
          bullhornUrl: "https://bh/3",
        }),
      );

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
    previewEmailToRecord.mockImplementation(
      async ({ recordId }: { recordId: number }) =>
        recordId === 1
          ? ready(1, "One", "one@example.com")
          : ready(2, "Two", "two@example.com"),
    );
    deliverPreparedEmail.mockResolvedValueOnce({
      ok: false,
      error: "mailbox_reconnect_required",
      message: "reconnect",
      connectUrl: "https://connect.example/m365",
      recipient: ready(1, "One", "one@example.com").recipient,
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
      bullhornSession: SESSION,
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
    expect(deliverPreparedEmail).toHaveBeenCalledTimes(1);
  });

  it("fails the preview on an unknown merge tag before reading Bullhorn", async () => {
    const { previewEmailsToRecords } = await load();
    const result = await previewEmailsToRecords({
      userId: "user-1",
      recipients: [{ entityType: "Candidate", recordId: 1 }],
      subject: "Hi {{fistName}}",
      body: "Body",
    });

    expect(result).toMatchObject({ ok: false, error: "unknown_merge_field" });
    if (result.ok) return;
    expect(result.message).toContain("{{fistName}}");
    expect(result.message).toContain("{{firstName}}");
    expect(previewEmailToRecord).not.toHaveBeenCalled();
  });

  it("returns rendered examples, including one that used a fallback", async () => {
    const values = (firstName: string | null) => ({ firstName });
    previewEmailToRecord.mockImplementation(
      async ({ recordId }: { recordId: number }) => {
        if (recordId === 5) {
          return {
            ok: false,
            error: "missing_merge_value",
            message: "Five has no Bullhorn value for {{firstName}}",
            missingFields: ["firstName"],
            recipient: ready(5, "Five", "five@example.com").recipient,
          };
        }
        if (recordId === 4) {
          return ready(4, "Four", "four@example.com", {
            subject: "Hi there",
            body: "Hi there,",
            mergeValues: values(null),
            usedFallback: true,
          });
        }
        const first = ["", "Ana", "Ben", "Cy"][recordId]!;
        return ready(recordId, first, `${first.toLowerCase()}@example.com`, {
          subject: `Hi ${first}`,
          body: `Hi ${first},`,
          mergeValues: values(first),
        });
      },
    );

    const { previewEmailsToRecords } = await load();
    const result = await previewEmailsToRecords({
      userId: "user-1",
      recipients: [1, 2, 3, 4, 5].map((recordId) => ({
        entityType: "Candidate" as const,
        recordId,
      })),
      subject: "Hi {{firstName|there}}",
      body: "Hi {{firstName|there}},",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mergeFieldsUsed).toEqual(["firstName"]);
    expect(result.examples).toHaveLength(3);
    expect(result.examples.map((e) => e.subject)).toEqual([
      "Hi Ana",
      "Hi Ben",
      "Hi there",
    ]);
    expect(result.examples[2]).toMatchObject({
      recordId: 4,
      usedFallback: true,
    });
    expect(result.skipped).toEqual([
      expect.objectContaining({
        recordId: 5,
        error: "missing_merge_value",
        missingFields: ["firstName"],
      }),
    ]);
    expect(result.ready.map((r) => r.mergeValues)).toEqual([
      { firstName: "Ana" },
      { firstName: "Ben" },
      { firstName: "Cy" },
      { firstName: null },
    ]);
  });

  it("rejects a confirm whose recipient list differs from the preview", async () => {
    previewEmailToRecord.mockImplementation(
      async ({ recordId }: { recordId: number }) =>
        ready(recordId, `R${recordId}`, `r${recordId}@example.com`),
    );

    const { previewEmailsToRecords, sendEmailsToRecords } = await load();
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients: [
        { entityType: "Candidate", recordId: 1 },
        { entityType: "Candidate", recordId: 2 },
      ],
      subject: "Hi {{firstName|there}}",
      body: "Body",
    });
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");

    const result = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: SESSION,
      recipients: [
        { entityType: "Candidate", recordId: 1 },
        { entityType: "Candidate", recordId: 3 },
      ],
      subject: "Hi {{firstName|there}}",
      body: "Body",
      confirmToken: preview.confirmToken,
    });

    expect(result).toMatchObject({ ok: false, error: "confirm_mismatch" });
    expect(deliverPreparedEmail).not.toHaveBeenCalled();
  });

  it("rejects a confirm whose body template differs from the preview", async () => {
    previewEmailToRecord.mockResolvedValue(ready(1, "One", "one@example.com"));

    const { previewEmailsToRecords, sendEmailsToRecords } = await load();
    const recipients = [{ entityType: "Candidate" as const, recordId: 1 }];
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients,
      subject: "Hi",
      body: "Hi {{firstName|there}},",
    });
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");

    const result = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: SESSION,
      recipients,
      subject: "Hi",
      body: "Hello {{firstName|there}},",
      confirmToken: preview.confirmToken,
    });

    expect(result).toMatchObject({ ok: false, error: "confirm_mismatch" });
    expect(deliverPreparedEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when a resolved value changed in Bullhorn after preview", async () => {
    let calls = 0;
    previewEmailToRecord.mockImplementation(
      async ({ recordId }: { recordId: number }) => {
        calls += 1;
        if (recordId === 2 && calls > 2) {
          return ready(2, "Bea", "two@example.com", {
            subject: "Hi Bea",
            mergeValues: { firstName: "Bea" },
          });
        }
        const first = recordId === 1 ? "Al" : "Bo";
        return ready(
          recordId,
          first,
          `${recordId === 1 ? "one" : "two"}@example.com`,
          {
            subject: `Hi ${first}`,
            mergeValues: { firstName: first },
          },
        );
      },
    );

    const { previewEmailsToRecords, sendEmailsToRecords } = await load();
    const recipients = [
      { entityType: "Candidate" as const, recordId: 1 },
      { entityType: "Candidate" as const, recordId: 2 },
    ];
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients,
      subject: "Hi {{firstName}}",
      body: "Body",
    });
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");

    const result = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: SESSION,
      recipients,
      subject: "Hi {{firstName}}",
      body: "Body",
      confirmToken: preview.confirmToken,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "preview_stale",
      changed: [
        expect.objectContaining({
          recordId: 2,
          reason: "bullhorn_value_changed",
        }),
      ],
    });
    expect(deliverPreparedEmail).not.toHaveBeenCalled();

    const retry = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: SESSION,
      recipients,
      subject: "Hi {{firstName}}",
      body: "Body",
      confirmToken: preview.confirmToken,
    });
    expect(retry).toMatchObject({ ok: false, error: "confirm_required" });
  });
});
