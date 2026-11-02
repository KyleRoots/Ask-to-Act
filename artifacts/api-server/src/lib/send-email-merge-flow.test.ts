import { beforeEach, describe, expect, it, vi } from "vitest";

const getCandidate = vi.fn();
const getContact = vi.fn();
const addNote = vi.fn();
const getUserMailboxStatus = vi.fn();
const getMailboxConnectUrlForUser = vi.fn();
const sendMailViaMicrosoft365 = vi.fn();
const createEmailSendLog = vi.fn();
const noop = vi.fn();

class MailboxNotConnectedError extends Error {
  constructor(public readonly connectUrl: string) {
    super("not connected");
  }
}
class MailboxReconnectRequiredError extends Error {
  constructor(public readonly connectUrl: string) {
    super("reconnect");
  }
}
class MailSendError extends Error {
  constructor(
    public readonly category: string,
    message: string,
  ) {
    super(message);
  }
}

vi.mock("./bullhorn-client.js", () => ({ addNote, getCandidate, getContact }));

vi.mock("./m365-auth.js", () => ({
  MailboxNotConnectedError,
  MailboxReconnectRequiredError,
  getUserMailboxStatus,
  getMailboxConnectUrlForUser,
}));

vi.mock("./m365-mail.js", () => ({ MailSendError, sendMailViaMicrosoft365 }));

vi.mock("./email-send-log.js", () => ({
  createEmailSendLog,
  markEmailSendAttempted: noop,
  markEmailSendSucceeded: noop,
  markEmailBullhornLogged: noop,
  markEmailBullhornLogFailed: noop,
  safeMarkEmailSendFailed: noop,
}));

vi.mock("@workspace/db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ name: "Rae Recruiter", email: "rae@example.com" }],
  };
  return {
    db: { select: () => chain },
    usersTable: { id: "id", name: "name", email: "email" },
  };
});

type Person = {
  firstName: string;
  lastName: string;
  name?: string;
  email: string;
  status?: string;
};

const people = new Map<number, Person>();

function seed(id: number, person: Person) {
  people.set(id, { status: "Active", ...person });
}

const SESSION = { kind: "user", userId: "user-1" } as never;
const SUBJECT = "Quick question for {{firstName|there}}";
const BODY =
  "Hi {{firstName|there}},\n\nAre you open to roles near you?\n\n{{fullName}}, reply anytime.";

describe("merge-field email flow (real preview + send, external services mocked)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    people.clear();
    getCandidate.mockImplementation(async ({ id }: { id: number }) => {
      const p = people.get(id);
      return { data: p ? { id, ...p } : {} };
    });
    getUserMailboxStatus.mockResolvedValue({
      connected: true,
      mailboxEmail: "rae@example.com",
    });
    sendMailViaMicrosoft365.mockResolvedValue({
      provider: "microsoft365",
      senderEmail: "rae@example.com",
      providerMessageId: null,
      internetMessageId: null,
    });
    let log = 0;
    createEmailSendLog.mockImplementation(async () => `log-${++log}`);
    let note = 500;
    addNote.mockImplementation(async () => ({ noteId: ++note }));
  });

  async function loadBulk() {
    const mod = await import("./send-email-to-records.js");
    mod.clearBulkEmailConfirmTokensForTests();
    return mod;
  }

  it("previews rendered examples and sends exactly that text, with the note and ledger storing it", async () => {
    seed(1, { firstName: "Jane", lastName: "Doe", email: "jane@example.com" });
    seed(2, {
      firstName: "Omar",
      lastName: "Haddad",
      email: "omar@example.com",
    });
    seed(3, {
      firstName: "",
      lastName: "Kim",
      name: "",
      email: "kim@example.com",
    });
    seed(4, {
      firstName: "",
      lastName: "",
      name: "",
      email: "blank@example.com",
    });
    seed(5, { firstName: "Lee", lastName: "Wu", email: "" });

    const { previewEmailsToRecords, sendEmailsToRecords } = await loadBulk();
    const recipients = [1, 2, 3, 4, 5].map((recordId) => ({
      entityType: "Candidate" as const,
      recordId,
    }));
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients,
      subject: SUBJECT,
      body: BODY,
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");
    expect(preview.subject).toBe(SUBJECT);
    expect(preview.examples).toHaveLength(3);
    expect(preview.examples.map((e) => e.subject)).toEqual([
      "Quick question for Jane",
      "Quick question for Omar",
      "Quick question for there",
    ]);
    expect(preview.examples[0]!.body).toBe(
      "Hi Jane,\n\nAre you open to roles near you?\n\nJane Doe, reply anytime.",
    );
    expect(preview.examples[2]!.body).toContain("Hi there,");
    expect(preview.examples[2]!.body).toContain("Kim, reply anytime.");
    expect(preview.skipped).toEqual([
      expect.objectContaining({
        recordId: 4,
        error: "missing_merge_value",
        missingFields: ["fullName"],
      }),
      expect.objectContaining({ recordId: 5, error: "missing_email" }),
    ]);
    expect(sendMailViaMicrosoft365).not.toHaveBeenCalled();

    const result = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: SESSION,
      recipients,
      subject: SUBJECT,
      body: BODY,
      confirmToken: preview.confirmToken,
    });

    expect(result).toMatchObject({
      ok: true,
      sentCount: 3,
      failedCount: 0,
      skippedCount: 0,
    });
    const mails = sendMailViaMicrosoft365.mock.calls.map(([a]) => a);
    expect(mails.map((m) => [m.recipientEmail, m.subject])).toEqual([
      ["jane@example.com", "Quick question for Jane"],
      ["omar@example.com", "Quick question for Omar"],
      ["kim@example.com", "Quick question for there"],
    ]);
    for (const m of mails) {
      expect(`${m.subject}\n${m.body}`).not.toMatch(/\{\{|\}\}/);
    }
    expect(mails[1].body).toBe(
      "Hi Omar,\n\nAre you open to roles near you?\n\nOmar Haddad, reply anytime.",
    );

    const ledger = createEmailSendLog.mock.calls.map(([a]) => a);
    expect(ledger.map((l) => [l.recordId, l.subject, l.body])).toEqual(
      mails.map((m, i) => [[1, 2, 3][i], m.subject, m.body]),
    );

    const notes = addNote.mock.calls.map(([, a]) => a.comments as string);
    expect(notes[0]).toContain("Subject: Quick question for Jane");
    expect(notes[0]).toContain(
      "Summary: Hi Jane, Are you open to roles near you? Jane Doe, reply anytime.",
    );
    expect(notes[2]).toContain("Subject: Quick question for there");
    for (const n of notes) expect(n).not.toContain("{{");
  });

  it("requires a new preview when a Bullhorn value changed after preview", async () => {
    seed(1, { firstName: "Jane", lastName: "Doe", email: "jane@example.com" });
    seed(2, {
      firstName: "Omar",
      lastName: "Haddad",
      email: "omar@example.com",
    });

    const { previewEmailsToRecords, sendEmailsToRecords } = await loadBulk();
    const recipients = [1, 2].map((recordId) => ({
      entityType: "Candidate" as const,
      recordId,
    }));
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients,
      subject: SUBJECT,
      body: BODY,
    });
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");

    seed(2, {
      firstName: "Omer",
      lastName: "Haddad",
      email: "omar@example.com",
    });

    const result = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: SESSION,
      recipients,
      subject: SUBJECT,
      body: BODY,
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
    expect(sendMailViaMicrosoft365).not.toHaveBeenCalled();
    expect(createEmailSendLog).not.toHaveBeenCalled();
    expect(addNote).not.toHaveBeenCalled();
  });

  it("requires a new preview when a previewed recipient email changed", async () => {
    seed(1, { firstName: "Jane", lastName: "Doe", email: "jane@example.com" });

    const { previewEmailsToRecords, sendEmailsToRecords } = await loadBulk();
    const recipients = [{ entityType: "Candidate" as const, recordId: 1 }];
    const preview = await previewEmailsToRecords({
      userId: "user-1",
      recipients,
      subject: "Hello",
      body: "Body",
    });
    if (!preview.ok || !preview.confirmToken) throw new Error("expected token");

    seed(1, {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane.new@example.com",
    });

    const result = await sendEmailsToRecords({
      userId: "user-1",
      bullhornSession: SESSION,
      recipients,
      subject: "Hello",
      body: "Body",
      confirmToken: preview.confirmToken,
    });

    expect(result).toMatchObject({ ok: false, error: "preview_stale" });
    expect(sendMailViaMicrosoft365).not.toHaveBeenCalled();
  });

  describe("send_email_to_record (single)", () => {
    it("renders merge fields and stores the rendered text in the ledger and note", async () => {
      seed(7, {
        firstName: "Priya",
        lastName: "Shah",
        email: "priya@example.com",
      });
      const { sendEmailToRecord } = await import("./send-email-to-record.js");

      const result = await sendEmailToRecord({
        userId: "user-1",
        bullhornSession: SESSION,
        entityType: "Candidate",
        recordId: 7,
        subject: "Hi {{firstName}}",
        body: "Hello {{fullName}},\nThanks!",
      });

      expect(result).toMatchObject({ ok: true, subject: "Hi Priya" });
      expect(sendMailViaMicrosoft365).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: "Hi Priya",
          body: "Hello Priya Shah,\nThanks!",
        }),
      );
      expect(createEmailSendLog).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: "Hi Priya",
          body: "Hello Priya Shah,\nThanks!",
        }),
      );
      const comments = addNote.mock.calls[0]![1].comments as string;
      expect(comments).toContain("Subject: Hi Priya");
      expect(comments).toContain("Summary: Hello Priya Shah, Thanks!");
    });

    it("fails an unknown tag before reading Bullhorn and sends nothing", async () => {
      const { previewEmailToRecord, sendEmailToRecord } =
        await import("./send-email-to-record.js");
      const preview = await previewEmailToRecord({
        userId: "user-1",
        entityType: "Candidate",
        recordId: 7,
        subject: "Hi {{fistName}}",
        body: "Body",
      });
      expect(preview).toMatchObject({
        ok: false,
        error: "unknown_merge_field",
      });

      const sent = await sendEmailToRecord({
        userId: "user-1",
        bullhornSession: SESSION,
        entityType: "Candidate",
        recordId: 7,
        subject: "Hi {{fistName}}",
        body: "Body",
      });
      expect(sent).toMatchObject({ ok: false, error: "unknown_merge_field" });
      expect(getCandidate).not.toHaveBeenCalled();
      expect(sendMailViaMicrosoft365).not.toHaveBeenCalled();
    });

    it("refuses to send 'Hi ,' when the value is missing and there is no fallback", async () => {
      seed(8, { firstName: "", lastName: "Ito", email: "ito@example.com" });
      const { sendEmailToRecord } = await import("./send-email-to-record.js");

      const result = await sendEmailToRecord({
        userId: "user-1",
        bullhornSession: SESSION,
        entityType: "Candidate",
        recordId: 8,
        subject: "Hello",
        body: "Hi {{firstName}},",
      });

      expect(result).toMatchObject({
        ok: false,
        error: "missing_merge_value",
        missingFields: ["firstName"],
      });
      expect(sendMailViaMicrosoft365).not.toHaveBeenCalled();
      expect(createEmailSendLog).not.toHaveBeenCalled();
    });

    it("strips CR/LF from a Bullhorn value before it reaches the subject", async () => {
      seed(9, {
        firstName: "Max\r\nBcc: someone@example.com",
        lastName: "Roe",
        email: "max@example.com",
      });
      const { sendEmailToRecord } = await import("./send-email-to-record.js");

      await sendEmailToRecord({
        userId: "user-1",
        bullhornSession: SESSION,
        entityType: "Candidate",
        recordId: 9,
        subject: "Hi {{firstName}}",
        body: "Body",
      });

      const subject = sendMailViaMicrosoft365.mock.calls[0]![0]
        .subject as string;
      expect(subject).toBe("Hi Max Bcc: someone@example.com");
      expect(subject).not.toMatch(/[\r\n]/);
    });
  });
});
